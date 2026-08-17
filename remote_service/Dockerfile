FROM python:3.12-slim
WORKDIR /app
COPY remote_service/requirements.txt /app/remote_service/requirements.txt
RUN pip install --no-cache-dir -r /app/remote_service/requirements.txt
COPY termdeck/__init__.py termdeck/remote_protocol.py /app/termdeck/
COPY remote_service /app/remote_service
ENV PYTHONUNBUFFERED=1
CMD ["sh", "-c", "uvicorn remote_service.main:app --host 0.0.0.0 --port ${PORT:-8080} --proxy-headers"]
