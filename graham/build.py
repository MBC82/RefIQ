#!/usr/bin/env python3
"""Build graham/index.html: one file with every chapter embedded behind tabs.
Add a chapter: save chapters/chapterN.html, add a title below, run `python3 build.py`."""
import json, pathlib
here = pathlib.Path(__file__).parent
titles = {1: "Chapter 1", 2: "Chapter 2"}
chapters = [{"id": str(n), "title": t, "html": (here / f"chapters/chapter{n}.html").read_text(encoding="utf-8")}
            for n, t in titles.items()]
data = json.dumps(chapters, ensure_ascii=False).replace("</", "<\\/")
out = (here / "chapters/shell.html").read_text(encoding="utf-8").replace("/*CHAPTERS*/[]", data)
(here / "index.html").write_text(out, encoding="utf-8")
print("wrote index.html", len(out), "bytes")
