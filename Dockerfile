FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV PORT=8080 PYTHONUNBUFFERED=1
CMD exec gunicorn --bind :$PORT --workers 2 --threads 4 --timeout 120 server:app
