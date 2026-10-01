from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    data_sources_dir: Path
    data_work_dir: Path
    data_clips_dir: Path

    anthropic_api_key: str = ""
    claude_model: str = "claude-sonnet-4-6"

    whisper_model: str = "large-v3"
    whisper_compute_type: str = "int8"
    whisper_device: str = "auto"
    # Which Whisper implementation to use:
    #   auto           -- whispercpp on macOS, whispercli when whisper-cli
    #                     is on PATH (or WHISPER_CLI_PATH set), else ctranslate2
    #   ctranslate2    -- faster-whisper (CTranslate2 + CUDA on Linux+NVIDIA)
    #   whispercpp     -- pywhispercpp (whisper.cpp + Metal on Apple Silicon)
    #   whispercli     -- our pre-built whisper.cpp Vulkan binary, subprocessed
    whisper_backend: str = "auto"

    # An explicit repair model selects this backend for repair. With an empty
    # model, repair tries the normal backend first and this as its fallback.
    # Cached weights are required unless first-use download is explicitly enabled.
    transcript_repair_backend: str = "ctranslate2"
    transcript_repair_model: str = ""
    transcript_repair_allow_model_download: bool = False

    # Optional isolated WhisperX interpreter. Leave empty to run the backend
    # without PyTorch; alignment jobs require an explicit worker environment.
    alignment_python: str = ""
    alignment_model: str = "WAV2VEC2_ASR_BASE_960H"
    alignment_model_dir: str = ""
    alignment_device: str = "cpu"
    alignment_language: str = "en"

    # whispercli backend: path to the whisper-cli(.exe) binary and the dir
    # holding ggml-<model>.bin files. Empty = look on PATH for the binary
    # and ~/.cache/whisper.cpp/ for the models. install-windows.ps1 sets
    # both explicitly when it downloads the pre-built bundle from a
    # ConnectClips release.
    whisper_cli_path: str = ""
    whisper_model_dir: str = ""

    # Admin-mode password and the secret used to sign the admin session cookie.
    # If session_secret is empty, the SessionMiddleware will refuse to start —
    # set both in .env on first run.
    admin_password: str = ""
    session_secret: str = ""

    # Comma-separated Tailscale logins (emails) that get admin rights
    # automatically when their request carries Tailscale identity headers.
    # Falls back to the password flow if absent or if the request didn't come
    # through Tailscale Serve.
    admin_tailscale_logins: str = ""


settings = Settings()
