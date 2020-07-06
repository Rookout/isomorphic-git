// @ts-check
import '../typedefs.js'

import { GitRemoteManager } from '../managers/GitRemoteManager.js'
import { collect } from '../utils/collect.js'
import { filterCapabilities } from '../utils/filterCapabilities.js'
import { parseUploadPackResponse } from '../wire/parseUploadPackResponse.js'
import { writeUploadPackRequest } from '../wire/writeUploadPackRequest.js'
import { listpack } from '../utils/git-list-pack.js'
import { GitPackIndex } from '../models/GitPackIndex.js'
import { GitTree } from '../models/GitTree.js'
import { join } from 'path'
import { GitCommit } from '../models/GitCommit.js'

// ask for a specific blob from remote git server
// `oid` is the object id of the blob
export async function fetchBlob({ oid, http, url }) {
  const GitRemoteHTTP = GitRemoteManager.getRemoteHelperFor({ url })
  const remoteHTTP = await GitRemoteHTTP.discover({
    http,
    service: 'git-upload-pack',
    url,
    headers: {},
  })
  const capabilities = filterCapabilities(
    [...remoteHTTP.capabilities],
    [
      'multi_ack_detailed',
      'no-done',
      'side-band-64k',
      // Note: I removed 'thin-pack' option since our code doesn't "fatten" packfiles,
      // which is necessary for compatibility with git. It was the cause of mysterious
      // 'fatal: pack has [x] unresolved deltas' errors that plagued us for some time.
      // isomorphic-git is perfectly happy with thin packfiles in .git/objects/pack but
      // canonical git it turns out is NOT.
      'ofs-delta',
      `agent=itsamitush`,
    ]
  )
  const packstream = writeUploadPackRequest({
    capabilities,
    wants: [oid],
  })
  const packbuffer = Buffer.from(await collect(packstream))
  const raw = await GitRemoteHTTP.connect({
    http,
    service: 'git-upload-pack',
    url,
    body: [packbuffer],
    headers: {},
    auth: {},
  })
  const response = await parseUploadPackResponse(raw.body)
  const packfile = Buffer.from(await collect(response.packfile))
  const idx = await GitPackIndex.fromPack({ pack: packfile });
  const blob = await idx.read({ oid })
  return blob
}
