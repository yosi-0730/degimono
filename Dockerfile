FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    TZ=Asia/Tokyo \
    DB_PATH=/app/data/degimono.db

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py index.html m5_dummy.html ./
EXPOSE 5000

# SQLite + MQTTスレッドのため worker は1つ（スレッドで並列処理）
CMD ["gunicorn", "-b", "0.0.0.0:5000", "--workers", "1", "--threads", "4", "app:app"]
