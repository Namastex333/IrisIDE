from pathlib import Path

RECEIPT = Path(__file__).parent / "receipt.txt"


def format_line(total: float) -> str:
    return f"Total paid: ${total:.2f}\n"


def save_receipt(total: float) -> None:
    RECEIPT.write_text(format_line(total))


def print_receipt() -> None:
    print(RECEIPT.read_text())
