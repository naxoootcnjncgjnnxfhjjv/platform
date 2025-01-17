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

import { WorkerEntrypoint } from 'cloudflare:workers'
import { type IRequestStrict, type RequestHandler, Router, error, html } from 'itty-router'

import { handleBlobDelete, handleBlobGet, handleBlobHead, handleUploadFormData } from './blob'
import { cors } from './cors'
import { LoggedKVNamespace, LoggedR2Bucket, requestTimeAfter, requestTimeBefore } from './measure'
import { handleImageGet } from './image'
import { handleS3Blob } from './s3'
import { handleVideoMetaGet } from './video'
import { handleSignAbort, handleSignComplete, handleSignCreate } from './sign'
import {
  handleMultipartUploadStart,
  handleMultipartUploadPart,
  handleMultipartUploadComplete,
  handleMultipartUploadAbort
} from './multipart'
import { type BlobRequest, type WorkspaceRequest } from './types'

const { preflight, corsify } = cors({
  maxAge: 86400
})

const router = Router<IRequestStrict, [Env, ExecutionContext], Response>({
  before: [preflight, requestTimeBefore],
  finally: [corsify, requestTimeAfter]
})

const withWorkspace: RequestHandler<WorkspaceRequest> = (request: WorkspaceRequest) => {
  if (request.params.workspace === undefined || request.params.workspace === '') {
    return error(400, 'Missing workspace')
  }
  request.workspace = decodeURIComponent(request.params.workspace)
}

const withBlob: RequestHandler<BlobRequest> = (request: BlobRequest) => {
  if (request.params.workspace === undefined || request.params.workspace === '') {
    return error(400, 'Missing workspace')
  }
  if (request.params.name === undefined || request.params.name === '') {
    return error(400, 'Missing blob name')
  }
  request.workspace = decodeURIComponent(request.params.workspace)
  request.name = decodeURIComponent(request.params.name)
}

router
  .get('/blob/:workspace/:name', withBlob, handleBlobGet)
  .head('/blob/:workspace/:name', withBlob, handleBlobHead)
  .delete('/blob/:workspace/:name', withBlob, handleBlobDelete)
  // Image
  .get('/image/:transform/:workspace/:name', withBlob, handleImageGet)
  // Video
  .get('/video/:workspace/:name/meta', withBlob, handleVideoMetaGet)
  // Form Data
  .post('/upload/form-data/:workspace', withWorkspace, handleUploadFormData)
  // Signed URL
  .post('/upload/signed-url/:workspace/:name', withBlob, handleSignCreate)
  .put('/upload/signed-url/:workspace/:name', withBlob, handleSignComplete)
  .delete('/upload/signed-url/:workspace/:name', withBlob, handleSignAbort)
  // Multipart
  .post('/upload/multipart/:workspace/:name', withBlob, handleMultipartUploadStart)
  .post('/upload/multipart/:workspace/:name/part', withBlob, handleMultipartUploadPart)
  .post('/upload/multipart/:workspace/:name/complete', withBlob, handleMultipartUploadComplete)
  .post('/upload/multipart/:workspace/:name/abort', withBlob, handleMultipartUploadAbort)
  // S3
  .post('/upload/s3/:workspace/:name', withBlob, handleS3Blob)
  .all('/', () =>
    html(
      `Huly&reg; Datalake&trade; <a href="https://huly.io">https://huly.io</a>
      &copy; 2024 <a href="https://hulylabs.com">Huly Labs</a>`
    )
  )
  .all('*', () => error(404))

export default class DatalakeWorker extends WorkerEntrypoint<Env> {
  constructor (ctx: ExecutionContext, env: Env) {
    env = {
      ...env,
      datalake_blobs: new LoggedKVNamespace(env.datalake_blobs),
      DATALAKE_APAC: new LoggedR2Bucket(env.DATALAKE_APAC),
      DATALAKE_EEUR: new LoggedR2Bucket(env.DATALAKE_EEUR),
      DATALAKE_WEUR: new LoggedR2Bucket(env.DATALAKE_WEUR),
      DATALAKE_ENAM: new LoggedR2Bucket(env.DATALAKE_ENAM),
      DATALAKE_WNAM: new LoggedR2Bucket(env.DATALAKE_WNAM)
    }
    super(ctx, env)
  }

  async fetch (request: Request): Promise<Response> {
    return await router.fetch(request, this.env, this.ctx).catch(error)
  }

  async getBlob (workspace: string, name: string): Promise<ArrayBuffer> {
    const request = new Request(`https://datalake/blob/${workspace}/${name}`)
    const response = await router.fetch(request)

    if (!response.ok) {
      console.error({ error: 'datalake error: ' + response.statusText, workspace, name })
      throw new Error(`Failed to fetch blob: ${response.statusText}`)
    }

    return await response.arrayBuffer()
  }

  async putBlob (workspace: string, name: string, data: ArrayBuffer | Blob | string, type: string): Promise<void> {
    const request = new Request(`https://datalake/upload/form-data/${workspace}`)

    const body = new FormData()
    const blob = new Blob([data], { type })
    body.set('file', blob, name)

    const response = await router.fetch(request, { method: 'POST', body })

    if (!response.ok) {
      console.error({ error: 'datalake error: ' + response.statusText, workspace, name })
      throw new Error(`Failed to fetch blob: ${response.statusText}`)
    }
  }
}
