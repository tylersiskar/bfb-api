"""
Shared Database Connection
===========================
Single Postgres connection helper used by all scripts that access the DB.
"""

import os
import psycopg2
from dotenv import load_dotenv

load_dotenv()


def connect_db():
    """Connect to PostgreSQL using environment variables. Validates all required vars are present."""
    dbname = os.getenv("PG_DB")
    user = os.getenv("PG_USER")
    password = os.getenv("PG_PASSWORD")
    host = os.getenv("PG_HOST")

    if not all([dbname, user, password, host]):
        missing = [
            k for k, v in {
                "PG_DB": dbname, "PG_USER": user,
                "PG_PASSWORD": password, "PG_HOST": host
            }.items() if not v
        ]
        raise RuntimeError(f"Missing database env vars: {', '.join(missing)}")

    return psycopg2.connect(dbname=dbname, user=user, password=password, host=host)
