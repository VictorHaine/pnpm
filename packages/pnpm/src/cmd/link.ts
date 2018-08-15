import {PackageJson} from '@pnpm/types'
import {
  DependenciesType,
  getPref,
  getSaveType,
  upsertDependenciesToPackageJson,
} from '@pnpm/utils'
import pLimit = require('p-limit')
import {StoreController} from 'package-store'
import path = require('path')
import pathAbsolute = require('path-absolute')
import R = require('ramda')
import {
  install,
  InstallOptions,
  link,
  linkToGlobal,
} from 'supi'
import {cached as createStoreController} from '../createStoreController'
import findWorkspacePackages from '../findWorkspacePackages'
import getConfigs from '../getConfigs'
import {PnpmOptions} from '../types'
import {recursive} from './recursive'

const installLimit = pLimit(4)

export default async (
  input: string[],
  opts: PnpmOptions,
) => {
  const cwd = opts && opts.prefix || process.cwd()

  const storeControllerCache = new Map<string, Promise<{path: string, ctrl: StoreController}>>()

  // pnpm link
  if (!input || !input.length) {
    const s = await createStoreController(storeControllerCache, opts)
    const lOpts = Object.assign(opts, {
      store: s.path,
      storeController: s.ctrl,
    })
    await linkToGlobal(cwd, lOpts)
    return
  }

  const [pkgPaths, pkgNames] = R.partition((inp) => inp.startsWith('.'), input)

  if (pkgNames.length) {
    if (opts.workspacePrefix) {
      const pkgs = await findWorkspacePackages(opts.workspacePrefix)

      const pkgsFoundInWorkspace = pkgs.filter((pkg) => pkgNames.indexOf(pkg.manifest.name) !== -1)
      const specsToUpsert = [] as Array<{name: string, pref: string, saveType: DependenciesType}>
      const saveType = getSaveType(opts)
      pkgsFoundInWorkspace.forEach((pkgFromWorkspace) => {
        pkgPaths.push(pkgFromWorkspace.path)
        specsToUpsert.push({
          name: pkgFromWorkspace.manifest.name,
          pref: getPref(pkgFromWorkspace.manifest.name, pkgFromWorkspace.manifest.name, pkgFromWorkspace.manifest.version, {
            saveExact: opts.saveExact === true,
            savePrefix: opts.savePrefix || '^',
          }),
          saveType: saveType as DependenciesType,
        })
      })
      const linkedToPkg = pkgs.find((pkg) => pkg.path === opts.prefix) as {path: string, manifest: PackageJson}
      linkedToPkg.manifest = await upsertDependenciesToPackageJson(opts.prefix, specsToUpsert)

      return recursive(pkgs, [], opts, 'link', 'link')
    }

    const globalPkgPath = pathAbsolute(opts.globalPrefix)
    pkgNames.forEach((pkgName) => pkgPaths.push(path.join(globalPkgPath, 'node_modules', pkgName)))
  }

  const store = await createStoreController(storeControllerCache, opts)
  const linkOpts = Object.assign(opts, {
    store: store.path,
    storeController: store.ctrl,
  })

  await Promise.all(
    pkgPaths.map((prefix) => installLimit(async () => {
      const s = await createStoreController(storeControllerCache, opts)
      await install({
        ...await getConfigs({...opts.cliArgs, prefix}, {excludeReporter: true}),
        store: s.path,
        storeController: s.ctrl,
      } as InstallOptions)
    })),
  )
  await link(pkgPaths, path.join(cwd, 'node_modules'), linkOpts)

  await Promise.all(
    Array.from(storeControllerCache.values())
      .map(async (storeControllerPromise) => {
        const storeControllerHolder = await storeControllerPromise
        await storeControllerHolder.ctrl.close()
      }),
  )
}
