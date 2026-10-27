import asyncio, base64, io, json, sys, time
from pathlib import Path
from PIL import Image
from playwright.async_api import async_playwright
sys.path.insert(0, str(Path(__file__).parent))
from specs import SPECS

OUT = Path(sys.argv[1])
IDS = [int(x) for x in sys.argv[2].split(",")] if len(sys.argv) > 2 and sys.argv[2] != "all" else sorted(SPECS)
SIZE = int(sys.argv[3]) if len(sys.argv) > 3 else 1200
FINAL = int(sys.argv[4]) if len(sys.argv) > 4 else 640
OUT.mkdir(parents=True, exist_ok=True)
HERE = Path(__file__).parent

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-watchdog"])
        pg = await b.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        await pg.goto((HERE / "render.html").as_uri())
        await pg.add_script_tag(path=str(HERE / "labels.js"))
        if errs:
            print("ERR", errs); return
        for i in IDS:
            s = dict(SPECS[i])
            t0 = time.time()
            url = await pg.evaluate("""([s,size])=>{const lab=s.label?makeLabel(s.label):null;return renderSpec(s,size,lab);}""", [s, SIZE])
            img = Image.open(io.BytesIO(base64.b64decode(url.split(",")[1]))).convert("RGB")
            img = img.resize((FINAL, FINAL), Image.LANCZOS)
            img.save(OUT / f"p{i}.webp", "WEBP", quality=84, method=6)
            print(i, s["model"], f"{time.time()-t0:.1f}s", flush=True)
        if errs: print("ERR", errs)
        await b.close()

asyncio.run(main())
