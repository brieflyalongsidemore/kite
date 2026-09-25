FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 KITE_DATA=/data
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY kite ./kite
COPY web ./web
COPY extension ./extension

RUN useradd --create-home kite && mkdir -p /data && chown kite /data
USER kite
VOLUME /data
EXPOSE 8788

CMD ["python", "-m", "kite", "--host", "0.0.0.0", "--port", "8788"]
