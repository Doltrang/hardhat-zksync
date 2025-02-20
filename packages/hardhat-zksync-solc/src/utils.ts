import semver from 'semver';
import { ZKSOLC_COMPILERS_SELECTOR_MAP, SOLCJS_EXECUTABLE_CODE } from './constants';
import { CompilerOutputSelection, MissingLibrary, ZkSolcConfig } from './types';
import crypto from 'crypto';
import { SolcConfig } from 'hardhat/types';
import { CompilerVersionInfo } from './compile/downloader';
import fse from 'fs-extra';
import lockfile from 'proper-lockfile';
import { ZkSyncSolcPluginError } from './errors';

export function filterSupportedOutputSelections(outputSelection: CompilerOutputSelection, zkCompilerVersion: string): CompilerOutputSelection {
    const filteredOutputSelection: CompilerOutputSelection = {};
    const versionComponents = getVersionComponents(zkCompilerVersion);
    let supportedOutputSelections: string[];

    switch (true) {
        case versionComponents[0] <= 1 && versionComponents[1] <= 3 && versionComponents[2] <= 5:
            supportedOutputSelections = ZKSOLC_COMPILERS_SELECTOR_MAP['1.3.5'];
            break;
        default:
            supportedOutputSelections = [...ZKSOLC_COMPILERS_SELECTOR_MAP['1.3.5'], 'metadata', 'userdoc', 'devdoc'];
            break;
    }

    for (const [file, contractSelection] of Object.entries(outputSelection)) {
        filteredOutputSelection[file] = {};

        for (const [contract, outputs] of Object.entries(contractSelection)) {
            filteredOutputSelection[file][contract] = outputs.filter((output) =>
                supportedOutputSelections.includes(output)
            );
        }
    }

    return filteredOutputSelection;
}

export function updateCompilerConf(compiler: SolcConfig, zksolc: ZkSolcConfig) {
    const [major, minor] = getVersionComponents(compiler.version);
    if (major === 0 && minor < 8 && zksolc.settings.forceEvmla) {
        console.warn('zksolc solidity compiler versions < 0.8 work with forceEvmla enabled by default');
    }
    let settings = compiler.settings || {};

    // Override the default solc optimizer settings with zksolc optimizer settings.
    compiler.settings = { ...settings, optimizer: { ...zksolc.settings.optimizer } };

    // Remove metadata settings from solidity settings.
    delete compiler.settings.metadata;
    // Override the solc metadata settings with zksolc metadata settings.
    if (zksolc.settings.metadata) {
        compiler.settings.metadata = { ...zksolc.settings.metadata };
    }

    // zkSolc supports only a subset of solc output selections
    compiler.settings.outputSelection = filterSupportedOutputSelections(compiler.settings.outputSelection, zksolc.version);
}

export function zeroxlify(hex: string): string {
    hex = hex.toLowerCase();
    return hex.slice(0, 2) === '0x' ? hex : `0x${hex}`;
}

export function isURL(url: string): boolean {
    try {
        const locator = new URL(url);
        return locator.protocol === 'http:' || locator.protocol === 'https:';
    } catch (e) {
        return false;
    }
}

export function sha1(str: string): string {
    return crypto.createHash('sha1').update(str).digest('hex');
}

export function saltFromUrl(url: string): string {
    return sha1(url);
}

export function getZksolcUrl(repo: string, version: string): string {
    // @ts-ignore
    const platform = { darwin: 'macosx', linux: 'linux', win32: 'windows' }[process.platform];
    // @ts-ignore
    const toolchain = { linux: '-musl', win32: '-gnu', darwin: '' }[process.platform];
    const arch = process.arch == 'x64' ? 'amd64' : process.arch;
    const ext = process.platform == 'win32' ? '.exe' : '';
    return `${repo}/raw/main/${platform}-${arch}/zksolc-${platform}-${arch}${toolchain}-v${version}${ext}`;
}

export function pluralize(n: number, singular: string, plural?: string) {
    if (n === 1) {
        return singular;
    }

    if (plural !== undefined) {
        return plural;
    }

    return `${singular}s`;
}

export function getVersionComponents(version: string): number[] {
    const versionComponents = version.split('.');
    return [
        parseInt(versionComponents[0]),
        parseInt(versionComponents[1]),
        parseInt(versionComponents[2])
    ];
}

export function isVersionInRange(version: string, versionInfo: CompilerVersionInfo): boolean {
    const latest = versionInfo.latest;
    const minVersion = versionInfo.minVersion;

    return semver.gte(version, minVersion) && semver.lte(version, latest);
  }

// Generate SolcJS executable code
export function generateSolcJSExecutableCode(solcJsPath: string, workingDir: string): string {
    return SOLCJS_EXECUTABLE_CODE
        .replace(/SOLCJS_PATH/g, solcJsPath)
        .replace(/WORKING_DIR/g, workingDir);
}

// Find all the libraries that are missing from the contracts
export function findMissingLibraries(zkSolcOutput: any): Set<string> {
    const missingLibraries = new Set<string>();

    for (let filePath in zkSolcOutput.contracts) {
        for (let contractName in zkSolcOutput.contracts[filePath]) {
            const contract = zkSolcOutput.contracts[filePath][contractName];
            if (contract.missingLibraries && contract.missingLibraries.length > 0) {
                contract.missingLibraries.forEach((library: string) => {
                    missingLibraries.add(library);
                });
            }
        }
    }
    
    return missingLibraries;
}

export function mapMissingLibraryDependencies(zkSolcOutput: any, missingLibraries: Set<string>): Array<MissingLibrary> {
    const dependencyMap = new Array<MissingLibrary>();

    missingLibraries.forEach(library => {
        const [libFilePath, libContractName] = library.split(":");
        if (zkSolcOutput.contracts[libFilePath] && zkSolcOutput.contracts[libFilePath][libContractName]) {
            const contract = zkSolcOutput.contracts[libFilePath][libContractName];
            if (contract.missingLibraries) {
                dependencyMap.push({
                    contractName: libContractName,
                    contractPath: libFilePath,
                    missingLibraries: contract.missingLibraries
                });
            }
        }
    });

    return dependencyMap;
}

// Get or create the libraries file. If the file doesn't exist, create it with an empty array
const getOrCreateLibraries = async (path: string): Promise<any[]> => {
    // Ensure the file exists
    if (!(await fse.pathExists(path))) {
        await fse.outputFile(path, '[]');  // Initialize with an empty array
    }

    // Return the file's content
    return await fse.readJSON(path);
};

// Write missing libraries to file and lock the file while writing
export const writeLibrariesToFile = async (path: string, libraries: any[]): Promise<void> => {
    try {
        let existingLibraries = await getOrCreateLibraries(path); // Ensure that the file exists
        await lockfile.lock(path, { retries: { retries: 10, maxTimeout: 1000 } });
        
        existingLibraries = await getOrCreateLibraries(path); // Read again after locking
        const combinedLibraries = [...existingLibraries, ...libraries];
        fse.outputFileSync(path, JSON.stringify(combinedLibraries, null, 4));
    } catch (e) {
        throw new ZkSyncSolcPluginError(`Failed to write missing libraries file: ${e}`);
    } finally {
        await lockfile.unlock(path);
    }
};