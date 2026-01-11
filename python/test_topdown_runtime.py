import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

# Import runtime/exporter from this repo without packaging.
THIS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(THIS_DIR))

from topdown_runtime import (
    TopDownIdNotFound,
    TopDownNotFound,
    find_topdown_root,
    td,
)


class TestTopDownRuntime(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name).resolve()
        (self.root / ".topdown").mkdir(parents=True, exist_ok=True)
        self.config = self.root / ".topdown" / "config.json"

        self._old_env = dict(os.environ)
        os.environ["TOPDOWN_ROOT"] = str(self.root)

        self.write_config(
            rows=[
                {
                    "id": "cla7-2",
                    "locked": False,
                    "name": "class 7 variant 2",
                    "args": "--foo 1 --bar=two",
                    "expr": "x + y",
                },
                {
                    "id": "func3.7",
                    "locked": True,
                    "name": "sub id",
                    "args": "",
                    "expr": "",
                },
            ]
        )

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._old_env)
        self._tmp.cleanup()

    def write_config(self, *, rows):
        payload = {"version": 1, "rows": rows, "history": [], "playheadIndex": 0}
        self.config.write_text(__import__("json").dumps(payload, indent=2) + "\n", encoding="utf-8")

    def test_find_root_via_env(self):
        found = find_topdown_root()
        self.assertEqual(found, self.root)

    def test_find_root_walk_up(self):
        # Remove env override; ensure upward search works.
        os.environ.pop("TOPDOWN_ROOT", None)
        nested = self.root / "a" / "b" / "c"
        nested.mkdir(parents=True, exist_ok=True)
        found = find_topdown_root(nested)
        self.assertEqual(found, self.root)

    def test_td_resolves_row(self):
        row = td("cla7-2")
        self.assertEqual(row.id, "cla7-2")
        self.assertFalse(row.locked)
        self.assertEqual(row.name, "class 7 variant 2")
        self.assertEqual(row.expr, "x + y")
        self.assertEqual(row.args_list(), ["--foo", "1", "--bar=two"])

    def test_td_resolves_dotted_id(self):
        row = td("func3.7")
        self.assertTrue(row.locked)
        self.assertEqual(row.id, "func3.7")

    def test_td_missing_id_raises(self):
        with self.assertRaises(TopDownIdNotFound):
            td("nope")

    def test_missing_config_raises(self):
        os.environ.pop("TOPDOWN_ROOT", None)
        with tempfile.TemporaryDirectory() as other:
            with self.assertRaises(TopDownNotFound):
                find_topdown_root(other)

    def test_cache_reload_on_mtime_change(self):
        row = td("cla7-2")
        self.assertEqual(row.name, "class 7 variant 2")

        # Ensure mtime changes across filesystems.
        time.sleep(1.1)
        self.write_config(
            rows=[
                {
                    "id": "cla7-2",
                    "locked": False,
                    "name": "updated",
                    "args": "--foo 9",
                    "expr": "x",
                }
            ]
        )

        row2 = td("cla7-2")
        self.assertEqual(row2.name, "updated")
        self.assertEqual(row2.args_list(), ["--foo", "9"])


class TestTopDownExport(unittest.TestCase):
    def test_export_module(self):
        # Import exporter after sys.path tweak above.
        from topdown_export import export_python_module

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".topdown").mkdir(parents=True, exist_ok=True)
            (root / ".topdown" / "config.json").write_text(
                '{"version":1,"rows":[{"id":"a-1","locked":false,"name":"n","args":"","expr":""}]}'
            )

            out = root / ".topdown" / "generated" / "topdown_defs.py"
            export_python_module(out, root=str(root))
            self.assertTrue(out.exists())

            # Basic sanity: file contains TOPDOWN_ROWS.
            text = out.read_text("utf-8")
            self.assertIn("TOPDOWN_ROWS", text)
            self.assertIn("a-1", text)


if __name__ == "__main__":
    unittest.main()
