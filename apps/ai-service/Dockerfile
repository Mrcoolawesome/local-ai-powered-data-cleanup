FROM python:3.12-slim

WORKDIR /app

# Layer-cache dependency installs separately from app code — app code
# changes far more often than requirements.txt does.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY sandbox ./sandbox
COPY scraper-sandbox ./scraper-sandbox

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
