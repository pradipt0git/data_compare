"""Entry point for the Data Compare Utility."""

from app import create_app

app = create_app()

if __name__ == "__main__":
    # The reloader is disabled on purpose: overlapping Flask processes would
    # contend for the same SQLite database file.
    app.run(host="0.0.0.0", port=8000, debug=True, use_reloader=False)
