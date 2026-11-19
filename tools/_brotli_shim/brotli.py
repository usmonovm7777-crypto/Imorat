"""A stand-in for the "brotli" Python module, for machines where it cannot be installed: fontTools needs brotli to write
WOFF2, and Node.js has it built in. Used by tools/build_fonts.py only when the real module is missing."""
import subprocess
__version__ = "1.1.0"
MODE_GENERIC, MODE_TEXT, MODE_FONT = 0, 1, 2
_JS = ("const z=require('zlib'),c=[];process.stdin.on('data',d=>c.push(d)).on('end',()=>{const b=Buffer.concat(c),a=process.argv;"
       "process.stdout.write(a[1]==='d'?z.brotliDecompressSync(b):z.brotliCompressSync(b,{params:{[z.constants.BROTLI_PARAM_MODE]:+a[2],"
       "[z.constants.BROTLI_PARAM_QUALITY]:+a[3],[z.constants.BROTLI_PARAM_SIZE_HINT]:b.length}}))})")
def _run(args, data): return subprocess.run(["node", "-e", _JS, *args], input=bytes(data), capture_output=True, check=True).stdout
def compress(data, mode=MODE_GENERIC, quality=11, lgwin=22, lgblock=0): return _run(["c", str(mode), str(quality)], data)
def decompress(data): return _run(["d"], data)
