import { deflateRawSync } from 'zlib'
import { Writable } from 'stream'

// ── Minimal ZIP writer ──────────────────────────────────────────────────────────
// Enough of the format to produce a valid archive and no more. Written by hand
// rather than pulled from npm because this server carries almost no dependencies
// (ws + web-push), and everything ZIP needs is already in Node: `zlib.deflateRaw`
// IS the compression method 8 payload, and CRC-32 is thirty lines.
//
// Entries are written to the output stream ONE AT A TIME, with only the current
// file held in memory. A user export can run to hundreds of MB, and buffering the
// whole archive to return it as a value would put that on the heap for as long as
// the download takes — and on the WebSocket channel it would have to be base64'd
// through JSON on top. Streaming keeps peak memory at roughly one file.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** MS-DOS date/time, which is what the format stores. */
function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2)),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

interface CentralEntry {
  name: Buffer; crc: number; csize: number; usize: number
  offset: number; time: number; date: number; method: number
}

export class ZipWriter {
  private offset = 0
  private readonly central: CentralEntry[] = []

  constructor(private readonly out: Writable) {}

  private write(b: Buffer): void {
    this.out.write(b)
    this.offset += b.length
  }

  /**
   * Add one file. `name` is the path inside the archive and must use forward
   * slashes — the format says so, and a backslash here produces an archive whose
   * "directories" are literal characters in a filename on every other platform.
   */
  addFile(name: string, data: Buffer, mtime = new Date()): void {
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8')
    const { time, date } = dosDateTime(mtime)
    const crc = crc32(data)

    // Store rather than deflate when compression doesn't pay — already-compressed
    // bytes typically grow slightly, and the CPU is wasted either way.
    const deflated = deflateRawSync(data)
    const useDeflate = deflated.length < data.length
    const body   = useDeflate ? deflated : data
    const method = useDeflate ? 8 : 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)          // version needed
    local.writeUInt16LE(0, 6)           // flags
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)          // extra len

    this.central.push({
      name: nameBuf, crc, csize: body.length, usize: data.length,
      offset: this.offset, time, date, method,
    })
    this.write(local)
    this.write(nameBuf)
    this.write(body)
  }

  /** Write the central directory and end record. Nothing may be added after this. */
  finish(): void {
    const start = this.offset
    for (const e of this.central) {
      const h = Buffer.alloc(46)
      h.writeUInt32LE(0x02014b50, 0)
      h.writeUInt16LE(20, 4)            // version made by
      h.writeUInt16LE(20, 6)            // version needed
      h.writeUInt16LE(0, 8)             // flags
      h.writeUInt16LE(e.method, 10)
      h.writeUInt16LE(e.time, 12)
      h.writeUInt16LE(e.date, 14)
      h.writeUInt32LE(e.crc, 16)
      h.writeUInt32LE(e.csize, 20)
      h.writeUInt32LE(e.usize, 24)
      h.writeUInt16LE(e.name.length, 28)
      h.writeUInt16LE(0, 30)            // extra
      h.writeUInt16LE(0, 32)            // comment
      h.writeUInt16LE(0, 34)            // disk
      h.writeUInt16LE(0, 36)            // internal attrs
      h.writeUInt32LE(0, 38)            // external attrs
      h.writeUInt32LE(e.offset, 42)
      this.write(h)
      this.write(e.name)
    }

    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(0, 4)             // this disk
    end.writeUInt16LE(0, 6)             // disk with central dir
    end.writeUInt16LE(this.central.length, 8)
    end.writeUInt16LE(this.central.length, 10)
    end.writeUInt32LE(this.offset - start, 12)
    end.writeUInt32LE(start, 16)
    end.writeUInt16LE(0, 20)            // comment len
    this.write(end)
  }
}
