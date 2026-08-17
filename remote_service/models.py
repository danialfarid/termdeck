from pydantic import BaseModel


class GoogleLoginRequest(BaseModel):
    credential: str
    csrf_token: str
    pairing_id: str = ""
    return_to: str = "/"


class PairingResultRequest(BaseModel):
    pairing_secret: str
