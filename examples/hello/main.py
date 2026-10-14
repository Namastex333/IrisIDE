"""Tiny sample project for trying out Iris."""

import json
from pathlib import Path

from pricing import order_total
from report import save_receipt


def load_config() -> dict:
    return json.loads((Path(__file__).parent / "config.json").read_text())


def main() -> None:
    config = load_config()
    total = order_total(config["items"], config["tax_rate"])
    print(f"Order total for {len(config['items'])} items: ${total:.2f}")
    save_receipt(total)


if __name__ == "__main__":
    main()
