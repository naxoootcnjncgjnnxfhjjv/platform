//
// Copyright © 2024 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import { error, json } from 'itty-router'
import { type Sql } from 'postgres'
import db, { withPostgres } from './db'
import { cacheControl, hashLimit } from './const'
import { toUUID } from './encodings'
import { getSha256 } from './hash'
import { selectStorage } from './storage'
import { type BlobRequest, type WorkspaceRequest, type UUID } from './types'
import { copyVideo, deleteVideo } from './video'
import { measure, LoggedCache } from './measure'

interface BlobMetadata {
  lastModified: number
  type: string
  size: number
  name: string
}

export function getBlobURL (request: Request, workspace: string, name: string): string {
  const path = `/blob/${workspace}/${name}`
  return new URL(path, request.url).toString()
}

export async function handleBlobGet (request: BlobRequest, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { workspace, name } = request

  const cache = new LoggedCache(caches.default)
  const cached = await cache.match(request)
  if (cached !== undefined) {
    console.log({ message: 'cache hit' })
    return cached
  }

  const { bucket } = selectStorage(env, workspace)

  const blob = await withPostgres(env, ctx, (sql) => {
    return db.getBlob(sql, { workspace, name })
  })
  if (blob === null || blob.deleted) {
    return error(404)
  }

  const range = request.headers.has('Range') ? request.headers : undefined
  const object = await bucket.get(blob.filename, { range })
  if (object === null) {
    return error(404)
  }

  const headers = r2MetadataHeaders(object)
  if (range !== undefined && object?.range !== undefined) {
    headers.set('Content-Range', rangeHeader(object.range, object.size))
  }

  const length = object?.range !== undefined && 'length' in object.range ? object?.range?.length : undefined
  const status = length !== undefined && length < object.size ? 206 : 200

  const response = new Response(object?.body, { headers, status })

  if (response.status === 200) {
    ctx.waitUntil(cache.put(request, response.clone()))
  }

  return response
}

export async function handleBlobHead (request: BlobRequest, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { workspace, name } = request

  const { bucket } = selectStorage(env, workspace)

  const blob = await withPostgres(env, ctx, (sql) => {
    return db.getBlob(sql, { workspace, name })
  })
  if (blob === null || blob.deleted) {
    return error(404)
  }

  const head = await bucket.head(blob.filename)
  if (head?.httpMetadata === undefined) {
    return error(404)
  }

  const headers = r2MetadataHeaders(head)
  return new Response(null, { headers, status: 200 })
}

export async function handleBlobDelete (request: BlobRequest, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { workspace, name } = request

  try {
    await withPostgres(env, ctx, (sql) => {
      return Promise.all([db.deleteBlob(sql, { workspace, name }), deleteVideo(env, workspace, name)])
    })

    return new Response(null, { status: 204 })
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err)
    console.error({ error: 'failed to delete blob:' + message })
    return error(500)
  }
}

export async function handleUploadFormData (
  request: WorkspaceRequest,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const contentType = request.headers.get('Content-Type')
  if (contentType === null || !contentType.includes('multipart/form-data')) {
    console.error({ error: 'expected multipart/form-data' })
    return error(400, 'expected multipart/form-data')
  }

  const { workspace } = request

  let formData: FormData
  try {
    formData = await measure('fetch formdata', () => request.formData())
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err)
    console.error({ error: 'failed to parse form data', message })
    return error(400, 'failed to parse form data')
  }

  const files: [File, key: string][] = []
  formData.forEach((value: any, key: string) => {
    if (typeof value === 'object') files.push([value, key])
  })

  const result = await Promise.all(
    files.map(async ([file, key]) => {
      const { name, type, lastModified } = file
      try {
        const metadata = await withPostgres(env, ctx, (sql) => {
          return saveBlob(env, sql, file.stream(), file.size, type, workspace, name, lastModified)
        })

        // TODO this probably should happen via queue, let it be here for now
        if (type.startsWith('video/')) {
          const blobURL = getBlobURL(request, workspace, name)
          await copyVideo(env, blobURL, workspace, name)
        }

        return { key, metadata }
      } catch (err: any) {
        const error = err instanceof Error ? err.message : String(err)
        console.error('failed to upload blob:', error)
        return { key, error }
      }
    })
  )

  return json(result)
}

export async function saveBlob (
  env: Env,
  sql: Sql,
  stream: ReadableStream,
  size: number,
  type: string,
  workspace: string,
  name: string,
  lastModified: number
): Promise<BlobMetadata> {
  const { location, bucket } = selectStorage(env, workspace)

  const httpMetadata = { contentType: type, cacheControl, lastModified }
  const filename = getUniqueFilename()

  if (size <= hashLimit) {
    const [hashStream, uploadStream] = stream.tee()

    const hash = await getSha256(hashStream)
    const data = await db.getData(sql, { hash, location })

    if (data !== null) {
      // Lucky boy, nothing to upload, use existing blob
      await db.createBlob(sql, { workspace, name, hash, location })
    } else {
      await bucket.put(filename, uploadStream, { httpMetadata })
      await sql.begin((sql) => [
        db.createData(sql, { hash, location, filename, type, size }),
        db.createBlob(sql, { workspace, name, hash, location })
      ])
    }

    return { type, size, lastModified, name }
  } else {
    // For large files we cannot calculate checksum beforehead
    // upload file with unique filename and then obtain checksum
    const { hash } = await uploadLargeFile(bucket, stream, filename, { httpMetadata })
    const data = await db.getData(sql, { hash, location })
    if (data !== null) {
      // We found an existing blob with the same hash
      // we can safely remove the existing blob from storage
      await Promise.all([bucket.delete(filename), db.createBlob(sql, { workspace, name, hash, location })])
    } else {
      // Otherwise register a new hash and blob
      await sql.begin((sql) => [
        db.createData(sql, { hash, location, filename, type, size }),
        db.createBlob(sql, { workspace, name, hash, location })
      ])
    }

    return { type, size, lastModified, name }
  }
}

export async function handleBlobUploaded (
  env: Env,
  ctx: ExecutionContext,
  workspace: string,
  name: string,
  filename: UUID
): Promise<void> {
  const { location, bucket } = selectStorage(env, workspace)

  const object = await bucket.head(filename)
  if (object?.httpMetadata === undefined) {
    throw Error('blob not found')
  }

  const hash = object.checksums.md5 !== undefined ? digestToUUID(object.checksums.md5) : (crypto.randomUUID() as UUID)

  await withPostgres(env, ctx, async (sql) => {
    const data = await db.getData(sql, { hash, location })
    if (data !== null) {
      await Promise.all([bucket.delete(filename), db.createBlob(sql, { workspace, name, hash, location })])
    } else {
      const size = object.size
      const type = object.httpMetadata?.contentType ?? 'application/octet-stream'

      await sql.begin((sql) => [
        db.createData(sql, { hash, location, filename, type, size }),
        db.createBlob(sql, { workspace, name, hash, location })
      ])
    }
  })
}

async function uploadLargeFile (
  bucket: R2Bucket,
  stream: ReadableStream,
  filename: string,
  options: R2PutOptions
): Promise<{ hash: UUID }> {
  const digestStream = new crypto.DigestStream('SHA-256')

  const [digestFS, uploadFS] = stream.tee()

  const digestPromise = digestFS.pipeTo(digestStream)
  const uploadPromise = bucket.put(filename, uploadFS, options)

  await Promise.all([digestPromise, uploadPromise])

  const hash = digestToUUID(await digestStream.digest)

  return { hash }
}

function getUniqueFilename (): UUID {
  return crypto.randomUUID() as UUID
}

function digestToUUID (digest: ArrayBuffer): UUID {
  return toUUID(new Uint8Array(digest))
}

function rangeHeader (range: R2Range, size: number): string {
  const offset = 'offset' in range ? range.offset : undefined
  const length = 'length' in range ? range.length : undefined
  const suffix = 'suffix' in range ? range.suffix : undefined

  const start = suffix !== undefined ? size - suffix : offset ?? 0
  const end = suffix !== undefined ? size : length !== undefined ? start + length : size

  return `bytes ${start}-${end - 1}/${size}`
}

function r2MetadataHeaders (head: R2Object): Headers {
  return head.httpMetadata !== undefined
    ? new Headers({
      'Accept-Ranges': 'bytes',
      'Content-Length': head.size.toString(),
      'Content-Type': head.httpMetadata.contentType ?? '',
      'Content-Security-Policy': "default-src 'none';",
      'Cache-Control': head.httpMetadata.cacheControl ?? cacheControl,
      'Last-Modified': head.uploaded.toUTCString(),
      ETag: head.httpEtag
    })
    : new Headers({
      'Accept-Ranges': 'bytes',
      'Content-Length': head.size.toString(),
      'Content-Security-Policy': "default-src 'none';",
      'Cache-Control': cacheControl,
      'Last-Modified': head.uploaded.toUTCString(),
      ETag: head.httpEtag
    })
}
