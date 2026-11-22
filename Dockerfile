FROM python:3.12-slim
WORKDIR /app
COPY app.py .
COPY web/ web/
RUN chmod 755 /app /app/web && chmod 644 /app/app.py /app/web/* && mkdir -p /data && chown 65534:65534 /data
USER 65534:65534
ENV HOST=0.0.0.0 PORT=8000 QODEX_DB=/data/finance.sqlite3 QODEX_SEED=0
VOLUME ["/data"]
EXPOSE 8000
CMD ["python", "app.py"]
