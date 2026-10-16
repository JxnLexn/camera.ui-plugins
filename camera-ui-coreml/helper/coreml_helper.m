#import <Accelerate/Accelerate.h>
#import <CoreML/CoreML.h>
#import <CoreVideo/CoreVideo.h>

#define CM_MAX_DIMS 8

enum {
    CM_INPUT_ARRAY = 0,
    CM_INPUT_RGB = 1,
};

typedef struct {
    const char *name;
    int32_t kind;
    int32_t ndim;
    const int64_t *shape;
    const void *data;
} cm_input;

typedef struct {
    const char *name;
    int32_t ndim;
    const int64_t *shape;
    float *data;
} cm_output;

static void set_error(char *error, size_t size, NSString *message) {
    if (error != NULL && size > 0) {
        strlcpy(error, message.UTF8String ?: "unknown error", size);
    }
}

static MLFeatureValue *array_value(const cm_input *input, NSError **failure) {
    NSMutableArray<NSNumber *> *shape = [NSMutableArray arrayWithCapacity:(NSUInteger)input->ndim];
    NSMutableArray<NSNumber *> *strides = [NSMutableArray arrayWithCapacity:(NSUInteger)input->ndim];
    int64_t stride = 1;
    for (int32_t i = input->ndim - 1; i >= 0; i--) {
        [shape insertObject:@(input->shape[i]) atIndex:0];
        [strides insertObject:@(stride) atIndex:0];
        stride *= input->shape[i];
    }
    MLMultiArray *array = [[MLMultiArray alloc] initWithDataPointer:(void *)input->data
                                                              shape:shape
                                                           dataType:MLMultiArrayDataTypeFloat32
                                                            strides:strides
                                                        deallocator:nil
                                                              error:failure];
    return array == nil ? nil : [MLFeatureValue featureValueWithMultiArray:array];
}

static MLFeatureValue *rgb_value(const cm_input *input) {
    if (input->ndim != 3 || input->shape[2] != 3) {
        return nil;
    }
    size_t height = (size_t)input->shape[0];
    size_t width = (size_t)input->shape[1];
    CVPixelBufferRef buffer = NULL;
    if (CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, NULL, &buffer) !=
        kCVReturnSuccess) {
        return nil;
    }
    CVPixelBufferLockBaseAddress(buffer, 0);
    vImage_Buffer source = {(void *)input->data, height, width, width * 3};
    vImage_Buffer target = {CVPixelBufferGetBaseAddress(buffer), height, width, CVPixelBufferGetBytesPerRow(buffer)};
    vImage_Error converted = vImageConvert_RGB888toBGRA8888(&source, NULL, 255, &target, false, kvImageNoFlags);
    CVPixelBufferUnlockBaseAddress(buffer, 0);
    MLFeatureValue *value = converted == kvImageNoError ? [MLFeatureValue featureValueWithPixelBuffer:buffer] : nil;
    CVPixelBufferRelease(buffer);
    return value;
}

static BOOL copy_rows(const void *bytes, BOOL half, const int64_t *shape, const int64_t *strides, int32_t ndim,
                      float *out) {
    int64_t inner = shape[ndim - 1];
    int64_t step = strides[ndim - 1];
    int64_t rows = 1;
    for (int32_t d = 0; d < ndim - 1; d++) {
        rows *= shape[d];
    }
    uint16_t *gathered = NULL;
    if (half && step != 1 && (gathered = malloc((size_t)inner * sizeof(uint16_t))) == NULL) {
        return NO;
    }
    int64_t index[CM_MAX_DIMS] = {0};
    for (int64_t row = 0; row < rows; row++, out += inner) {
        int64_t offset = 0;
        for (int32_t d = 0; d < ndim - 1; d++) {
            offset += index[d] * strides[d];
        }
        if (half) {
            const uint16_t *source = (const uint16_t *)bytes + offset;
            if (gathered != NULL) {
                for (int64_t i = 0; i < inner; i++) {
                    gathered[i] = source[i * step];
                }
                source = gathered;
            }
            vImage_Buffer planar16 = {(void *)source, 1, (vImagePixelCount)inner, (size_t)inner * sizeof(uint16_t)};
            vImage_Buffer planar = {out, 1, (vImagePixelCount)inner, (size_t)inner * sizeof(float)};
            vImageConvert_Planar16FtoPlanarF(&planar16, &planar, kvImageNoFlags);
        } else if (step == 1) {
            memcpy(out, (const float *)bytes + offset, (size_t)inner * sizeof(float));
        } else {
            const float *source = (const float *)bytes + offset;
            for (int64_t i = 0; i < inner; i++) {
                out[i] = source[i * step];
            }
        }
        for (int32_t d = ndim - 2; d >= 0; d--) {
            if (++index[d] < shape[d]) {
                break;
            }
            index[d] = 0;
        }
    }
    free(gathered);
    return YES;
}

static NSString *copy_output(MLMultiArray *array, const cm_output *output) API_AVAILABLE(macos(12.3)) {
    int32_t ndim = (int32_t)array.shape.count;
    if (ndim != output->ndim || ndim < 1 || ndim > CM_MAX_DIMS || array.strides.count != array.shape.count) {
        return [NSString stringWithFormat:@"rank %d, expected %d", ndim, output->ndim];
    }
    BOOL half = array.dataType == MLMultiArrayDataTypeFloat16;
    if (!half && array.dataType != MLMultiArrayDataTypeFloat32) {
        return [NSString stringWithFormat:@"unsupported data type %ld", (long)array.dataType];
    }
    int64_t shape[CM_MAX_DIMS];
    int64_t strides[CM_MAX_DIMS];
    int64_t last = 0;
    for (int32_t d = 0; d < ndim; d++) {
        shape[d] = array.shape[(NSUInteger)d].longLongValue;
        strides[d] = array.strides[(NSUInteger)d].longLongValue;
        if (shape[d] != output->shape[d] || shape[d] < 1 || strides[d] < 0) {
            return [NSString stringWithFormat:@"shape %@, unexpected", array.shape];
        }
        last += (shape[d] - 1) * strides[d];
    }
    size_t element = half ? sizeof(uint16_t) : sizeof(float);
    const int64_t *dims = shape;
    const int64_t *steps = strides;
    __block NSString *problem = nil;
    [array getBytesWithHandler:^(const void *bytes, NSInteger size) {
      if ((size_t)(last + 1) * element > (size_t)size) {
          problem = @"strides run past the buffer";
          return;
      }
      if (!copy_rows(bytes, half, dims, steps, ndim, output->data)) {
          problem = @"out of memory";
      }
    }];
    return problem;
}

static NSString *copy_outputs(id<MLFeatureProvider> result, const cm_output *outputs, int32_t output_count)
    API_AVAILABLE(macos(12.3)) {
    for (int32_t i = 0; i < output_count; i++) {
        MLMultiArray *array = [result featureValueForName:@(outputs[i].name)].multiArrayValue;
        NSString *problem = array == nil ? @"missing" : copy_output(array, &outputs[i]);
        if (problem != nil) {
            return [NSString stringWithFormat:@"output %s: %@", outputs[i].name, problem];
        }
    }
    return nil;
}

static NSString *run_prediction(MLModel *model, id<MLFeatureProvider> provider, const cm_output *outputs,
                                int32_t output_count) API_AVAILABLE(macos(12.3)) {
    // the sync API allows one caller per model at a time, the async one is thread safe
    if (@available(macOS 14.0, *)) {
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        __block NSString *problem = nil;
        [model predictionFromFeatures:provider
                    completionHandler:^(id<MLFeatureProvider> result, NSError *failure) {
                      @try {
                          problem = result == nil ? (failure.localizedDescription ?: @"unknown error")
                                                  : copy_outputs(result, outputs, output_count);
                      } @catch (NSException *exception) {
                          problem = exception.reason ?: @"unknown error";
                      }
                      dispatch_semaphore_signal(done);
                    }];
        dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
        return problem;
    }
    NSError *failure = nil;
    id<MLFeatureProvider> result = nil;
    @synchronized(model) {
        result = [model predictionFromFeatures:provider error:&failure];
    }
    if (result == nil) {
        return failure.localizedDescription ?: @"unknown error";
    }
    return copy_outputs(result, outputs, output_count);
}

void *cm_load(const char *path, int32_t compute_units, char *error, size_t error_size) {
    if (@available(macOS 12.3, *)) {
        @autoreleasepool {
            @try {
                MLModelConfiguration *config = [MLModelConfiguration new];
                config.computeUnits = (MLComputeUnits)compute_units;
                NSURL *url = [NSURL fileURLWithPath:@(path) isDirectory:YES];
                NSError *failure = nil;
                MLModel *model = [MLModel modelWithContentsOfURL:url configuration:config error:&failure];
                if (model == nil) {
                    set_error(error, error_size, failure.localizedDescription);
                    return NULL;
                }
                return (__bridge_retained void *)model;
            } @catch (NSException *exception) {
                set_error(error, error_size, exception.reason);
                return NULL;
            }
        }
    }
    set_error(error, error_size, @"needs macOS 12.3 or newer");
    return NULL;
}

void cm_release(void *model) {
    if (model != NULL) {
        CFRelease(model);
    }
}

int32_t cm_predict(void *model, const cm_input *inputs, int32_t input_count, const cm_output *outputs,
                   int32_t output_count, char *error, size_t error_size) {
    if (@available(macOS 12.3, *)) {
        @autoreleasepool {
            @try {
                NSMutableDictionary<NSString *, MLFeatureValue *> *features =
                    [NSMutableDictionary dictionaryWithCapacity:(NSUInteger)input_count];
                NSError *failure = nil;
                for (int32_t i = 0; i < input_count; i++) {
                    MLFeatureValue *value = inputs[i].kind == CM_INPUT_RGB ? rgb_value(&inputs[i])
                                                                           : array_value(&inputs[i], &failure);
                    if (value == nil) {
                        set_error(error, error_size,
                                  [NSString stringWithFormat:@"input %s: %@", inputs[i].name,
                                                             failure.localizedDescription ?: @"invalid"]);
                        return -1;
                    }
                    features[@(inputs[i].name)] = value;
                }
                MLDictionaryFeatureProvider *provider = [[MLDictionaryFeatureProvider alloc] initWithDictionary:features
                                                                                                          error:&failure];
                if (provider == nil) {
                    set_error(error, error_size, failure.localizedDescription);
                    return -1;
                }
                NSString *problem = run_prediction((__bridge MLModel *)model, provider, outputs, output_count);
                if (problem != nil) {
                    set_error(error, error_size, problem);
                    return -1;
                }
                return 0;
            } @catch (NSException *exception) {
                set_error(error, error_size, exception.reason);
                return -1;
            }
        }
    }
    set_error(error, error_size, @"needs macOS 12.3 or newer");
    return -1;
}
