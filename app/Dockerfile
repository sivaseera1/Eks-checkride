FROM python:3.12-slim
RUN useradd -u 10001 -m app
WORKDIR /app
COPY app.py .
COPY static/ ./static/
USER 10001
EXPOSE 8080
ENV PYTHONUNBUFFERED=1
CMD ["python", "app.py"]
