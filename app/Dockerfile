FROM node:20-slim AS frontend-build

WORKDIR /frontend

COPY frontend/package*.json /frontend/
RUN npm install --no-audit --no-fund

COPY frontend/ /frontend/
RUN npm run build

FROM python:3.11-slim

WORKDIR /app

COPY app/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY app/ /app/
COPY --from=frontend-build /frontend/dist /app/frontend/dist

RUN mkdir -p /app/storage

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
