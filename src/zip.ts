/**
 * A tiny ZIP writer, enough for the OnSong binder export.
 *
 * Nothing is compressed — an .onsongbinder is a handful of small JSON and text
 * files, so storing them costs a few kilobytes and saves pulling in a deflate
 * implementation. Entries carry the UTF-8 flag, so umlauts in file names
 * survive. Directories are not written as their own entries: a path with "/"
 * in it is all any unzipper needs.
 *
 * Layout per the PKZIP APPNOTE: a local header plus data for every entry,
 * then a central directory repeating the headers, then the end record.
 */

export interface ZipEntry {
  /** Path inside the archive, "/" separated, never leading with "/". */
  path: string
  data: Uint8Array | string
}

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const END_SIGNATURE = 0x06054b50
/** Version 2.0 — the floor for anything a modern unzipper expects. */
const VERSION = 20
/** Bit 11: file names are UTF-8. */
const FLAG_UTF8 = 0x800
const METHOD_STORE = 0

let crcTable: Uint32Array | null = null

function table(): Uint32Array {
  if (crcTable) return crcTable
  const built = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let value = i
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    built[i] = value >>> 0
  }
  crcTable = built
  return built
}

export function crc32(data: Uint8Array): number {
  const lookup = table()
  let crc = 0xffffffff
  for (const byte of data) crc = lookup[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** MS-DOS date and time, the only timestamp a basic ZIP entry carries. */
function dosStamp(when: Date): { time: number; date: number } {
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
    date: ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  }
}

/** Grows on demand; a binder is small enough that copying is not worth avoiding. */
class ByteWriter {
  private bytes: Uint8Array<ArrayBuffer> = new Uint8Array(1024)
  private length = 0

  private reserve(extra: number): void {
    if (this.length + extra <= this.bytes.length) return
    let size = this.bytes.length * 2
    while (size < this.length + extra) size *= 2
    const grown = new Uint8Array(size)
    grown.set(this.bytes.subarray(0, this.length))
    this.bytes = grown
  }

  get offset(): number {
    return this.length
  }

  u16(value: number): void {
    this.reserve(2)
    this.bytes[this.length++] = value & 0xff
    this.bytes[this.length++] = (value >>> 8) & 0xff
  }

  u32(value: number): void {
    this.u16(value & 0xffff)
    this.u16((value >>> 16) & 0xffff)
  }

  raw(data: Uint8Array): void {
    this.reserve(data.length)
    this.bytes.set(data, this.length)
    this.length += data.length
  }

  result(): Uint8Array<ArrayBuffer> {
    return this.bytes.slice(0, this.length)
  }
}

/** Packs the entries into a ZIP archive, in the order they are given. */
export function zip(entries: ZipEntry[], now = new Date()): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  const { time, date } = dosStamp(now)
  const out = new ByteWriter()
  const directory: Array<{ name: Uint8Array; crc: number; size: number; offset: number }> = []

  for (const entry of entries) {
    const name = encoder.encode(entry.path)
    const data = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data
    const crc = crc32(data)
    directory.push({ name, crc, size: data.length, offset: out.offset })

    out.u32(LOCAL_SIGNATURE)
    out.u16(VERSION)
    out.u16(FLAG_UTF8)
    out.u16(METHOD_STORE)
    out.u16(time)
    out.u16(date)
    out.u32(crc)
    out.u32(data.length) // compressed
    out.u32(data.length) // uncompressed
    out.u16(name.length)
    out.u16(0) // no extra field
    out.raw(name)
    out.raw(data)
  }

  const directoryStart = out.offset
  for (const item of directory) {
    out.u32(CENTRAL_SIGNATURE)
    out.u16(VERSION) // made by
    out.u16(VERSION) // needed
    out.u16(FLAG_UTF8)
    out.u16(METHOD_STORE)
    out.u16(time)
    out.u16(date)
    out.u32(item.crc)
    out.u32(item.size)
    out.u32(item.size)
    out.u16(item.name.length)
    out.u16(0) // extra
    out.u16(0) // comment
    out.u16(0) // disk number
    out.u16(0) // internal attributes
    out.u32(0) // external attributes
    out.u32(item.offset)
    out.raw(item.name)
  }
  const directorySize = out.offset - directoryStart

  out.u32(END_SIGNATURE)
  out.u16(0) // this disk
  out.u16(0) // disk with the directory
  out.u16(directory.length)
  out.u16(directory.length)
  out.u32(directorySize)
  out.u32(directoryStart)
  out.u16(0) // no archive comment

  return out.result()
}
