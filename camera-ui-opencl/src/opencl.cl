__constant sampler_t sampler = CLK_NORMALIZED_COORDS_FALSE | CLK_ADDRESS_CLAMP_TO_EDGE | CLK_FILTER_NEAREST;

__kernel void process_frame(
    __read_only image2d_t input,
    __global float *background_model,
    __global float *temp_buffer,
    __write_only image2d_t output,
    __constant float *kernel_values,
    int kernel_size,
    int width,
    int height,
    float alpha,
    float threshold,
    int dilation_size,
    int first_frame
) {
    int x = get_global_id(0);
    int y = get_global_id(1);
    if (x >= width || y >= height) return;
    int idx = y * width + x;

    // Gaussian blur
    int radius = (kernel_size - 1) / 2;
    float blurred_value = 0.0f;
    for (int i = -radius; i <= radius; i++) {
        for (int j = -radius; j <= radius; j++) {
            int2 samplePos = (int2)(clamp(x + i, 0, width - 1), clamp(y + j, 0, height - 1));
            float4 pixel = read_imagef(input, sampler, samplePos);
            float weight = kernel_values[i + radius] * kernel_values[j + radius];
            blurred_value += pixel.x * weight;
        }
    }

    // Store blurred value in temp buffer
    temp_buffer[idx] = blurred_value;

    if (first_frame) {
        // Initialize background model
        background_model[idx] = blurred_value;
        write_imagef(output, (int2)(x, y), (float4)(0.0f, 0.0f, 0.0f, 1.0f));
    } else {
        // Background subtraction
        float bg_pixel = background_model[idx];

        // Update background model
        float updated_bg = bg_pixel * (1.0f - alpha) + blurred_value * alpha;
        background_model[idx] = updated_bg;

        // Compute difference and threshold
        float diff = fabs(blurred_value - bg_pixel);
        float mask_value = (diff > threshold) ? 1.0f : 0.0f;

        // Dilation
        float maxValue = mask_value;
        for (int dy = -dilation_size; dy <= dilation_size; dy++) {
            int sy = clamp(y + dy, 0, height - 1);
            for (int dx = -dilation_size; dx <= dilation_size; dx++) {
                int sx = clamp(x + dx, 0, width - 1);
                int neighbor_idx = sy * width + sx;
                float neighbor_pixel = background_model[neighbor_idx];
                float neighbor_blurred = temp_buffer[neighbor_idx];
                float neighbor_diff = fabs(neighbor_blurred - neighbor_pixel);
                float neighbor_mask = (neighbor_diff > threshold) ? 1.0f : 0.0f;
                maxValue = fmax(maxValue, neighbor_mask);
            }
        }

        write_imagef(output, (int2)(x, y), (float4)(maxValue, maxValue, maxValue, 1.0f));
    }
}