FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN --mount=type=secret,id=qodex_build_ca \
    if [ -f /run/secrets/qodex_build_ca ]; then export PIP_CERT=/run/secrets/qodex_build_ca; fi; \
    pip install --no-cache-dir -r requirements.txt
COPY app.py bank_statement.py pnl_template.py period_close.py pilot_access.py report_export.py db_admin.py user_accounts.py directory_admin.py .
COPY web/ web/
RUN chmod 755 /app /app/web && chmod 644 /app/*.py /app/web/* && mkdir -p /data && chown 65534:65534 /data
USER 65534:65534
ENV HOST=0.0.0.0 PORT=8000 QODEX_DB=/data/finance.sqlite3 QODEX_SEED=0
VOLUME ["/data"]
EXPOSE 8000
CMD ["python", "app.py"]
