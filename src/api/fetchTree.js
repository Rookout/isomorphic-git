// @ts-check
import '../typedefs.js'

import { join } from 'path'

import { GitRemoteManager } from '../managers/GitRemoteManager.js'
import { GitCommit } from '../models/GitCommit.js'
import { GitPackIndex } from '../models/GitPackIndex.js'
import { GitTree } from '../models/GitTree.js'
import { collect } from '../utils/collect.js'
import { filterCapabilities } from '../utils/filterCapabilities.js'
import { parseUploadPackResponse } from '../wire/parseUploadPackResponse.js'
import { writeUploadPackRequest } from '../wire/writeUploadPackRequest.js'
import { RemoteCapabilityError } from '../errors/RemoteCapabilityError.js'

/*
  fetchTree fetches only the tree hierarchy of a commit, using the filter-spec of git ("blob:none")
  and depth: 1.
  That way, the git server returns a packfile composed entirely with tree objects.
  We parse the packfile to build a tree of the repository and each blob has its sha-1 used to fetch it
  when needed.
  large portion of this code is taken from the fetch command.
  It is encouraged to read chapter 10 of the git book to understand some basic git internals:
  https://git-scm.com/book/en/v2/Git-Internals-Plumbing-and-Porcelain

  For a more technical description of the wire protocol visit: https://github.com/git/git/tree/master/Documentation/technical
  specifically: http-protocol, pack-protocol, partial-clone, protocol-v2, protocol-common
*/
export async function fetchTree({ http, url, commitId }) {
  // First we fetch the refs
  const GitRemoteHTTP = GitRemoteManager.getRemoteHelperFor({ url })
  const remoteHTTP = await GitRemoteHTTP.discover({
    http,
    service: 'git-upload-pack',
    url,
    headers: {},
  })
  if (!remoteHTTP.capabilities.has('filter')) {
    throw new RemoteCapabilityError('filter', 'filters')
  }
  // the only "want" we need is the requested commit
  const wants = [commitId]
  const capabilities = filterCapabilities(
    [...remoteHTTP.capabilities],
    [
      'multi_ack_detailed',
      'no-done',
      'filter',
      'side-band-64k',
      // Note: I removed 'thin-pack' option since our code doesn't "fatten" packfiles,
      // which is necessary for compatibility with git. It was the cause of mysterious
      // 'fatal: pack has [x] unresolved deltas' errors that plagued us for some time.
      // isomorphic-git is perfectly happy with thin packfiles in .git/objects/pack but
      // canonical git it turns out is NOT.
      'ofs-delta',
      `agent=git/isomorphic-git@Explorook`,
    ]
  )
  // create a pack request
  const packstream = writeUploadPackRequest({
    capabilities,
    wants,
    filters: ['blob:none'],
    depth: 1,
  })
  const packbuffer = Buffer.from(await collect(packstream))

  // ask for the packfile from remote server
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

  // now we have a packfile containing all we need, so we parse it
  const idx = await GitPackIndex.fromPack({ pack: packfile })

  // read the commit object
  const commitObj = await idx.read({ oid: commitId })
  const commit = GitCommit.from(commitObj.object)
  const commitHeaders = commit.parseHeaders()

  let repoTreeList = []
  const buildTreeList = async (path, oid) => {
    const tree = await idx.read({ oid })
    const parsedTree = GitTree.from(tree.object)
    for (const entry of parsedTree.entries()) {
      if (entry.type === 'blob') {
        repoTreeList.push({ fullpath: join(path, entry.path), oid: entry.oid })
      } else {
        await buildTreeList(join(path, entry.path), entry.oid)
      }
    }
  }
  await buildTreeList('', commitHeaders.tree)
  return repoTreeList
}
