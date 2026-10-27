import asyncio, base64, io, json, sys, time
from pathlib import Path
from PIL import Image
from playwright.async_api import async_playwright
HERE = Path(__file__).parent
specs = json.loads(Path(sys.argv[1]).read_text())
OUT = Path(sys.argv[2]); OUT.mkdir(parents=True, exist_ok=True)
SIZE = int(sys.argv[3]); FINAL = int(sys.argv[4])
only = sys.argv[5].split(",") if len(sys.argv) > 5 else None
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        pg = await b.new_page(); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        await pg.goto((HERE / "render.html").as_uri()); await pg.add_script_tag(path=str(HERE / "labels.js"))
        if errs: print("ERR", errs); return
        for name, s in specs.items():
            if only and name not in only: continue
            if (OUT / f"{name}.webp").exists() and not only: continue
            t0 = time.time()
            url = await pg.evaluate("""([s,size])=>{const lab=s.label?makeLabel(s.label):null;return renderSpec(s,size,lab);}""", [s, SIZE])
            img = Image.open(io.BytesIO(base64.b64decode(url.split(",")[1]))).convert("RGB").resize((FINAL, FINAL), Image.LANCZOS)
            img.save(OUT / f"{name}.webp", "WEBP", quality=84, method=6)
            print(name, f"{time.time()-t0:.1f}s", flush=True)
        if errs: print("ERR", errs)
        await b.close()
asyncio.run(main())
