"""Application factory for the Data Compare Utility."""

import os

from flask import Flask, send_from_directory

from .db import init_db

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT_DIR = os.path.join(ROOT_DIR, "output")
DB_PATH = os.path.join(OUTPUT_DIR, "compare.db")


def create_app(db_path=None, output_dir=None):
    output = output_dir or OUTPUT_DIR
    os.makedirs(output, exist_ok=True)

    app = Flask(
        __name__,
        static_folder=os.path.join(ROOT_DIR, "static"),
        static_url_path="/static",
    )
    app.config["ROOT_DIR"] = ROOT_DIR
    app.config["OUTPUT_DIR"] = output
    app.config["DB_PATH"] = db_path or DB_PATH
    app.config["MAX_CONTENT_LENGTH"] = 512 * 1024 * 1024

    init_db(app.config["DB_PATH"])

    from .routes import api

    app.register_blueprint(api, url_prefix="/api")

    @app.get("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    return app
