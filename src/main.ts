import * as process from "process";
import * as glob from "glob";
import * as compareVersions from "compare-versions";
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as setupPython from 'setup-python/lib/find-python'
import { ExecOptions } from "@actions/exec/lib/interfaces";

const getDefaultHost = () => {
  switch(process.platform) {
    case "win32":   return "windows";
    case "darwin":  return "mac";
    default:        return "linux";
  }
}

/**
 * Execute a command and capture stdout.
 *
 * @param command The command to execute
 * @param args    Arguments to the command
 * @return        An object that includes trimmed standard output and a return value.
 */
const executeCaptureStdout = async (command: string, args: string[]): Promise<{stdout: string, return_value: number}> => {
  let output = '';

  const options: ExecOptions = {
    listeners: {
      stdout: (data: Buffer) => { output += data.toString(); }
    }
  };
  const return_value = await exec.exec(command, args, options);
  return { stdout: output.trim(), return_value };
}

async function run() {
    try {
      if (core.getInput("setup-python") == "true") {
        // Use setup-python to ensure that python >=3.6 is installed
        const installed = await setupPython.findPythonVersion('>=3.6', 'x64')
        core.info(`Successfully setup ${installed.impl} (${installed.version})`)
      }

      const dir = (core.getInput("dir") || process.env.RUNNER_WORKSPACE) + "/Qt";
      const tools = core.getInput("tools");
      const setEnv = core.getInput("set-env");

      // Qt installer assumes basic requirements that are not installed by
      // default on Ubuntu.
      if (process.platform == "linux") {
        let cmd0 = "apt-get update"
        let cmd1 = "apt-get install build-essential libgl1-mesa-dev libxkbcommon-x11-0 libpulse-dev libxcb-util1 libxcb-glx0 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-randr0 libxcb-render-util0 libxcb-render0 libxcb-shape0 libxcb-shm0 libxcb-sync1 libxcb-xfixes0 libxcb-xinerama0 libxcb1 -y"
        if (core.getInput("install-deps") == "true") {
            await exec.exec("sudo " + cmd0)
            await exec.exec("sudo " + cmd1)
        } else if (core.getInput("install-deps") == "nosudo") {
            await exec.exec(cmd0)
            await exec.exec(cmd1)
        }
      }

      // accommodate for differences in python 3 executable name
      const pythonName = (process.platform == "win32") ? "python3" : "python";

      // set host automatically if omitted
      const host       = core.getInput("host")    || getDefaultHost();
      const target     = core.getInput("target")  || "desktop";

      // Determine actual version from SimpleSpec
      const simpleSpec = core.getInput("version") || "6.2";     // Default: get the latest LTS Qt available

      const determineVersion = async (): Promise<string> => {
        // Run `aqt list-qt --latest` to find the latest available Qt that fits the SimpleSpec
        // If simpleSpec is actually a version, `aqt list-qt` will return that version, iff it exists
        const { stdout: version, return_value } = await executeCaptureStdout(
          `${pythonName} -m aqt list-qt`,
          [host, target, "--spec", `"${simpleSpec}"`, "--latest"]
        );
        if (return_value !== 0) throw new Error(`Failed to resolve Qt version from SimpleSpec '${simpleSpec}'`);
        return version;
      }

      if (core.getInput("cached") != "true") {
        // 7-zip is required, and not included on macOS
        if (process.platform == "darwin") {
          await exec.exec("brew install p7zip")
        }

        await exec.exec(pythonName + " -m pip install setuptools wheel");
        await exec.exec(pythonName + " -m pip install \"py7zr" + core.getInput("py7zrversion") + "\"");
        await exec.exec(pythonName + " -m pip install \"aqtinstall" + core.getInput("aqtversion") + "\"");
        let arch = core.getInput("arch");
        const extra = core.getInput("extra");
        const modules = core.getInput("modules");
        const version = await determineVersion();


        //set arch automatically if omitted
        if (!arch) {
          if (host == "windows") {
            if (compareVersions.compare(version, '5.15.0', '>=')) { // if version is greater than or equal to 5.15.0
              arch = "win64_msvc2019_64";
            } else if (compareVersions.compare(version, '5.6.0', '<')) { // if version earlier than 5.6
              arch = "win64_msvc2013_64";
            } else if (compareVersions.compare(version, '5.9.0', '<')) { // if version is earlier than 5.9
              arch = "win64_msvc2015_64";
            } else { // otherwise
              arch = "win64_msvc2017_64";
            }
          } else if (host == "android") {
            arch = "android_armv7";
          }
        }

        //set args
        let args = [`${host}`, `${target}`, `${version}`];
        if (arch && ((host == "windows" || target == "android") || arch == "wasm_32")) {
          args.push(`${arch}`);
        }

        if (modules) {
          args.push("-m");
          modules.split(" ").forEach(function(currentModule) {
            args.push(currentModule);
          });
        }

        let extraArgs = ["-O", `${dir}`]

        if (extra) {
          extra.split(" ").forEach(function(string) {
            extraArgs.push(string);
          });
        }

        args = args.concat(extraArgs);

        //run aqtinstall with args, and install tools if requested
        if (core.getInput("tools-only") != "true") {
          await exec.exec(`${pythonName} -m aqt install-qt`, args);
        }
        if (tools) {
          tools.split(" ").forEach(async element => {
            const elements = element.split(",");
            const toolName = elements[0];
            const variantName = elements.length > 1 ? elements[elements.length - 1] : "";
            await exec.exec(`${pythonName} -m aqt install-tool ${host} ${target} ${toolName} ${variantName}`, extraArgs);
          });
        }
      }

      //set environment variables

      // Weird naming scheme exception for qt 5.9
      const version = await determineVersion();
      const version_dir = (version == '5.9.0') ? '5.9' : version;

      let qtPath = dir + "/" + version_dir;
      qtPath = glob.sync(qtPath + '/**/*')[0];
      if (setEnv == "true") {
        if (tools) {
            core.exportVariable('IQTA_TOOLS', dir + "/Tools");
        }
        if (process.platform == "linux") {
            if (process.env.LD_LIBRARY_PATH) {
                core.exportVariable('LD_LIBRARY_PATH', process.env.LD_LIBRARY_PATH + ":" + qtPath + "/lib");
            } else {
                core.exportVariable('LD_LIBRARY_PATH', qtPath + "/lib");
            }
        }
        if (process.platform != "win32") {
          if (process.env.PKG_CONFIG_PATH) {
              core.exportVariable('PKG_CONFIG_PATH', process.env.PKG_CONFIG_PATH + ":" + qtPath + "/lib/pkgconfig");
          } else {
              core.exportVariable('PKG_CONFIG_PATH', qtPath + "/lib/pkgconfig");
          }
      }
        // If less than qt6, set qt5_dir variable, otherwise set qt6_dir variable
        if (compareVersions.compare(version, '6.0.0', '<')) {
          core.exportVariable('Qt5_Dir', qtPath); // Incorrect name that was fixed, but kept around so it doesn't break anything
          core.exportVariable('Qt5_DIR', qtPath);
        } else {
          core.exportVariable('Qt6_DIR', qtPath);
        }
        core.exportVariable('QT_PLUGIN_PATH', qtPath + '/plugins');
        core.exportVariable('QML2_IMPORT_PATH', qtPath + '/qml');
        core.addPath(qtPath + "/bin");
      }
    } catch (error) {
      core.setFailed(error.message);
    }
}

run();
