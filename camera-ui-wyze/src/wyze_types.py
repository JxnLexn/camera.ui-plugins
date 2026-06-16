from typing import NotRequired, TypedDict


class WyzeConfig(TypedDict):
    username: str
    password: str
    apiId: str
    apiKey: str
    accessToken: NotRequired[str]
    refreshToken: NotRequired[str]


class WyzeCameraData(TypedDict):
    mac: str
    nickname: str
    product_model: str
    product_type: str
    firmware_ver: str
    p2p_id: str
    ip: str
    enr: str
    dtls: int
    is_online: bool
