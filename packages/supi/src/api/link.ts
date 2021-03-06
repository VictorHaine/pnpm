import {linkBinsOfPackages} from '@pnpm/link-bins'
import logger, {streamParser} from '@pnpm/logger'
import {read as readModulesYaml} from '@pnpm/modules-yaml'
import {PackageJson} from '@pnpm/types'
import {
  DependenciesType,
  dependenciesTypes,
  DependencyType,
  getSaveType,
  packageJsonLogger,
  removeOrphanPackages as removeOrphanPkgs,
  rootLogger,
  safeReadPackage,
  summaryLogger,
} from '@pnpm/utils'
import loadJsonFile = require('load-json-file')
import normalize = require('normalize-path')
import path = require('path')
import pathAbsolute = require('path-absolute')
import {
  pruneWithoutPackageJson as pruneShrinkwrap,
  Shrinkwrap,
  write as saveShrinkwrap,
  writeCurrentOnly as saveCurrentShrinkwrapOnly,
} from 'pnpm-shrinkwrap'
import R = require('ramda')
import symlinkDir = require('symlink-dir')
import getSpecFromPackageJson from '../getSpecFromPackageJson'
import readShrinkwrapFile from '../readShrinkwrapFiles'
import save, { guessDependencyType } from '../save'
import extendOptions, {
  InstallOptions,
} from './extendInstallOptions'
import getPref from './utils/getPref'

export default async function link (
  linkFromPkgs: string[],
  destModules: string,
  maybeOpts: InstallOptions & {
    linkToBin?: string,
  },
) {
  const reporter = maybeOpts && maybeOpts.reporter
  if (reporter) {
    streamParser.on('data', reporter)
  }
  maybeOpts.saveProd = maybeOpts.saveProd === true
  const opts = await extendOptions(maybeOpts)

  const shrFiles = await readShrinkwrapFile({
    force: opts.force,
    prefix: opts.prefix,
    registry: opts.registry,
    shrinkwrap: opts.shrinkwrap,
  })
  const oldShrinkwrap = R.clone(shrFiles.currentShrinkwrap)
  const pkg = await safeReadPackage(path.join(opts.prefix, 'package.json')) || undefined
  if (pkg) {
    packageJsonLogger.debug({
      initial: pkg,
      prefix: opts.prefix,
    })
  }
  const linkedPkgs: Array<{path: string, pkg: PackageJson}> = []
  const specsToUpsert = [] as Array<{name: string, pref: string, saveType: DependenciesType}>
  const saveType = getSaveType(opts)

  for (const linkFrom of linkFromPkgs) {
    const linkedPkg = await loadJsonFile(path.join(linkFrom, 'package.json'))
    specsToUpsert.push({
      name: linkedPkg.name,
      pref: getPref(linkedPkg.name, linkedPkg.name, linkedPkg.version, {
        saveExact: opts.saveExact,
        savePrefix: opts.savePrefix,
      }),
      saveType: (saveType || pkg && guessDependencyType(linkedPkg.name, pkg)) as DependenciesType,
    })

    const packagePath = normalize(path.relative(opts.prefix, linkFrom))
    const addLinkOpts = {
      linkedPkgName: linkedPkg.name,
      packagePath,
      pkg,
    }
    addLinkToShrinkwrap(shrFiles.currentShrinkwrap, addLinkOpts)
    addLinkToShrinkwrap(shrFiles.wantedShrinkwrap, addLinkOpts)

    linkedPkgs.push({path: linkFrom, pkg: linkedPkg})
  }

  const warn = (message: string) => logger.warn({message, prefix: opts.prefix})
  const updatedCurrentShrinkwrap = pruneShrinkwrap(shrFiles.currentShrinkwrap, warn)
  const updatedWantedShrinkwrap = pruneShrinkwrap(shrFiles.wantedShrinkwrap, warn)
  const modulesInfo = await readModulesYaml(destModules)
  await removeOrphanPkgs({
    bin: opts.bin,
    hoistedAliases: modulesInfo && modulesInfo.hoistedAliases || {},
    newShrinkwrap: updatedCurrentShrinkwrap,
    oldShrinkwrap,
    prefix: opts.prefix,
    shamefullyFlatten: opts.shamefullyFlatten,
    storeController: opts.storeController,
  })

  // Linking should happen after removing orphans
  // Otherwise would've been removed
  for (const linkedPkg of linkedPkgs) {
    // TODO: cover with test that linking reports with correct dependency types
    const stu = specsToUpsert.find((s) => s.name === linkedPkg.pkg.name)
    await linkToModules(linkedPkg.pkg, linkedPkg.path, destModules, {
      prefix: opts.prefix,
      saveType: stu && stu.saveType || saveType,
    })
  }

  const linkToBin = maybeOpts && maybeOpts.linkToBin || path.join(destModules, '.bin')
  await linkBinsOfPackages(linkedPkgs.map((p) => ({manifest: p.pkg, location: p.path})), linkToBin, {
    warn: (message: string) => logger.warn({message, prefix: opts.prefix}),
  })

  if (opts.saveDev || opts.saveProd || opts.saveOptional) {
    const newPkg = await save(opts.prefix, specsToUpsert)
    for (const specToUpsert of specsToUpsert) {
      updatedWantedShrinkwrap.specifiers[specToUpsert.name] = getSpecFromPackageJson(newPkg, specToUpsert.name) as string
    }
  }
  if (opts.shrinkwrap) {
    await saveShrinkwrap(opts.prefix, updatedWantedShrinkwrap, updatedCurrentShrinkwrap)
  } else {
    await saveCurrentShrinkwrapOnly(opts.prefix, updatedCurrentShrinkwrap)
  }

  summaryLogger.debug({prefix: opts.prefix})

  if (reporter) {
    streamParser.removeListener('data', reporter)
  }
}

function addLinkToShrinkwrap (
  shr: Shrinkwrap,
  opts: {
    linkedPkgName: string,
    packagePath: string,
    pkg?: PackageJson,
  },
) {
  const id = `link:${opts.packagePath}`
  let addedTo: DependenciesType | undefined
  for (const depType of dependenciesTypes) {
    if (!addedTo && opts.pkg && opts.pkg[depType] && opts.pkg[depType]![opts.linkedPkgName]) {
      addedTo = depType
      shr[depType] = shr[depType] || {}
      shr[depType]![opts.linkedPkgName] = id
    } else if (shr[depType]) {
      delete shr[depType]![opts.linkedPkgName]
    }
  }

  if (!addedTo) {
    shr.dependencies = shr.dependencies || {}
    shr.dependencies[opts.linkedPkgName] = id
  }

  // package.json might not be available when linking to global
  if (!opts.pkg) return

  const availableSpec = getSpecFromPackageJson(opts.pkg, opts.linkedPkgName)
  if (availableSpec) {
    shr.specifiers[opts.linkedPkgName] = availableSpec
  } else {
    delete shr.specifiers[opts.linkedPkgName]
  }
}

const DEP_TYPE_BY_DEPS_FIELD_NAME = {
  dependencies: 'prod',
  devDependencies: 'dev',
  optionalDependencies: 'optional',
}

async function linkToModules (
  pkg: PackageJson,
  linkFrom: string,
  modules: string,
  opts: {
    saveType?: DependenciesType,
    prefix: string,
  },
) {
  const dest = path.join(modules, pkg.name)
  rootLogger.debug({
    added: {
      dependencyType: opts.saveType && DEP_TYPE_BY_DEPS_FIELD_NAME[opts.saveType] as DependencyType,
      linkedFrom: linkFrom,
      name: pkg.name,
      realName: pkg.name,
      version: pkg.version,
    },
    prefix: opts.prefix,
  })
  await symlinkDir(linkFrom, dest)
}

export async function linkFromGlobal (
  pkgNames: string[],
  linkTo: string,
  maybeOpts: InstallOptions & {globalPrefix: string},
) {
  const reporter = maybeOpts && maybeOpts.reporter
  if (reporter) {
    streamParser.on('data', reporter)
  }
  const opts = await extendOptions(maybeOpts)
  const globalPkgPath = pathAbsolute(maybeOpts.globalPrefix)
  const linkFromPkgs = pkgNames.map((pkgName) => path.join(globalPkgPath, 'node_modules', pkgName))
  await link(linkFromPkgs, path.join(linkTo, 'node_modules'), opts)

  if (reporter) {
    streamParser.removeListener('data', reporter)
  }
}

export async function linkToGlobal (
  linkFrom: string,
  maybeOpts: InstallOptions & {
    globalBin: string,
    globalPrefix: string,
  },
) {
  const reporter = maybeOpts && maybeOpts.reporter
  if (reporter) {
    streamParser.on('data', reporter)
  }
  const opts = await extendOptions(maybeOpts)
  const globalPkgPath = pathAbsolute(maybeOpts.globalPrefix)
  await link([linkFrom], path.join(globalPkgPath, 'node_modules'), {
    ...opts,
    linkToBin: maybeOpts.globalBin,
    prefix: maybeOpts.globalPrefix,
  })

  if (reporter) {
    streamParser.removeListener('data', reporter)
  }
}
