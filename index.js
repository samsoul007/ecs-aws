#! /usr/bin/env node
const inquirer = require('inquirer');
const fs = require('fs');
const _ = require('lodash');
const yargs = require('yargs');
const emoji = require('node-emoji');
const promisify = require('util.promisify');
const MainExec = promisify(require('child_process').exec);
const childProcess = require('child_process');
const { spawn } = require('child_process');
const Table = require('cli-table3');
const commandExists = require('command-exists');
const timeAgo = require('node-time-ago');
const colors = require('colors');
const { Spinner } = require('clui');
const dashboard = require('./dashboard');
const {
  getServiceData,
  getLogStreams,
  getLogEvents,
  loadAWSProfile,
  loadAWSProfiles,
  updateService,
  checkTag,
  checkLogGroup,
  checkDockerRepo,
  checkTaskDefinition,
  checkCluster,
  checkService,
  loadRegions,
  loadRepositories,
  loadClusters,
  loadTaskDefinitions,
  loadServices,
  createECRRepository,
  createTaskDefinitionForNewService,
  loadLoadBalancers,
  loadListeners,
  createTargetGroup,
  createListenerRule,
  loadListenerRules,
  createECSService,
  waitForServiceRunning,
  deleteECRRepository,
  deleteCloudWatchLogGroup,
  deregisterTaskDefinition,
  deleteTargetGroup,
  deleteListenerRule,
  deleteECSService,
  createRoute53Record,
  deleteRoute53Record,
  checkCreatePermissions,
  checkDeletePermissions,
  getAccountId,
} = require('./aws');

// Start arguments
const { argv } = yargs
  .usage('$0 <cmd> [args]')
  .option('profile', {
    alias: 'p',
    describe: 'Profile to work on.',
    demandOption: false,
    type: 'string',
  })
  .option('c', {
    describe: 'Commit code.',
    demandOption: false,
  })
  .option('d', {
    describe: 'Deploy container.',
    demandOption: false,
  })
  .option('browser', {
    alias: 'b',
    describe: 'Open CloudWatch logs in browser (use with logs command).',
    demandOption: false,
    type: 'boolean',
  })
  .command('deploy', 'Deploy the code into ECR & ECS (will use the GIT short hash as version if available)')
  .command('run', 'Run local container.')
  .command('rebuild', 'Rebuild the image container from the Dockerfile.')
  .command('info', 'View a configuration table.')
  .command('events', 'View service events.')
  .command('dash', 'Dashboard (beta)')
  .command('logs', 'View service logs in terminal or browser (use --browser or -b flag).')
  .command('tail', 'Tail service logs in real-time (use --browser or -b flag to open CloudWatch Live Tail).')
  .command('check', 'Check configuration.')
  .command('configure', 'Change a config file configuration.')
  .command('init', 'Initialise a config file.')
  .command('delete-service', 'Delete an ECS service and all associated resources.')
  .help();

const cwd = process.cwd();

const log = (sText) => {
  console.log(emoji.emojify(sText));
};

const stdout = (sText) => {
  process.stdout.write(emoji.emojify(sText));
};

const exec = (...args) => MainExec(...args)

/*.then(res => {
  console.log(res)
  return res.stdout});*/


const spawnP = (cmd, verbose) => new Promise(((resolve) => {
  const options = {
    shell: true,
  };

  if (verbose) options.stdio = 'inherit';

  const depChild = spawn(cmd, options);

  depChild.on('exit', () => {
    resolve();
  });
}));

const compare = (a, b) => {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
};

const fileExists = path => new Promise(((resolve, reject) => {
  fs.stat(path, (err) => {
    if (err) {
      return reject(err);
    }

    return resolve(true);
  });
}));

const loadFile = path => Promise.resolve()
  .then(() => new Promise((resolve, reject) => {
    fs.readFile(path, (err, data) => {
      if (err) {
        return reject(err);
      }

      return resolve(data.toString());
    });
  }))
  .then(JSON.parse);

const logError = (err) => {
  log(`:bangbang:  ${err}`);
  return process.exit();
};

// List all ECSConfig files in the current directory
const listECSConfigFiles = () => {
  return new Promise((resolve, reject) => {
    fs.readdir(cwd, (err, files) => {
      if (err) return reject(err);

      const configFiles = files
        .filter(file => file.match(/^ECSConfig(_[^.]+)?\.json$/))
        .map(file => {
          const match = file.match(/^ECSConfig(?:_([^.]+))?\.json$/);
          return {
            file: file,
            profile: match[1] || 'default',
            displayName: match[1] ? `${match[1]} (${file})` : `default (${file})`
          };
        })
        .sort((a, b) => a.profile.localeCompare(b.profile));

      resolve(configFiles);
    });
  });
};

// Prompt user to select an ECSConfig profile
const selectECSConfigProfile = () => {
  return listECSConfigFiles()
    .then(configFiles => {
      if (configFiles.length === 0) {
        return Promise.reject(new Error('No ECSConfig files found in the current directory. Run "ecs-aws init" to create one.'));
      }

      return inquirer.prompt([{
        type: 'list',
        name: 'selectedProfile',
        message: 'Select an ECSConfig profile:',
        choices: configFiles.map(cfg => ({
          name: cfg.displayName,
          value: cfg.profile
        }))
      }]);
    })
    .then(answers => answers.selectedProfile);
};

const loadConfigFile = sConfFileName => loadFile(`${cwd}/${sConfFileName}`)
  .catch(() => Promise.reject(new Error(`Could not load the configuration file: ${sConfFileName}`)));


const commit = () => {
  log(':fire: Commit your code.');

  return fileExists(`${cwd}/.git`)
    .catch(() => Promise.reject(new Error('Not a git repository (or any of the parent directories).')))
    .then(() => inquirer.prompt([{
      type: 'input',
      name: 'commit',
      message: 'Enter commit text:',
    }])
      .then((answers) => {
        const spinner = new Spinner('Commiting your code. Please wait...', ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']);
        spinner.start();

        return exec('git add .')
          .then(() => exec(`git commit -m '${answers.commit}'`))
          .then(() => exec('git push origin master;'))
          .then(() => {
            spinner.stop();
            log(':+1: Code commited');

            return true;
          });
      }));
};

const rebuildNPM = oProfile => inquirer.prompt([{
  type: 'confirm',
  name: 'rebuild',
  message: 'Do you want to rebuild the NPM modules?',
  default: false,
}])
  .then((answers) => {
    if (!answers.rebuild) {
      return Promise.resolve(true);
    }
    const spinner = new Spinner('Installing NPM modules. Please wait...', ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']);
    spinner.start();

    const sImage = (`${oProfile.profile}/${oProfile.task}/${oProfile.dockerfile}:ecs-aws`).toLowerCase();

    return exec('rm -rf node_modules;')
      .then(() => spawnP(`docker run  -a stdout --rm -v ${process.cwd()}:/app -w /app '${sImage}' npm install`))
      .then(() => {
        spinner.stop();
        log(':+1: NPM modules finished installing.');
        return Promise.resolve(true);
      });
  });

// const getAWSAccountID = () => {
//   const sts = new AWS.STS();
//   return sts.getCallerIdentity({}).promise().then(data => data.Account);
// };

const buildImage = (arroProfileData, tag) => {
  const sImage = `${arroProfileData.repo}:${tag}`;
  const sRepoName = arroProfileData.repo.split('amazonaws.com/')[1];
  const spinner = new Spinner('Connecting to ECR', ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']);

  spinner.start();

  return exec(`aws ecr get-login --no-include-email ${arroProfileData.profile ? ` --profile ${arroProfileData.profile}` : ''}`)
    .then((result) => {
      const sResult = result.stdout.replace('-e none', '');
      return exec(sResult);
    }).then(() => {
      spinner.message(`Building image '${tag}' from docker file '${arroProfileData.dockerfile}'`, ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']);
      // console.log(`docker build --platform linux/amd64 -f ${arroProfileData.dockerfile} -t ${sRepoName} .`);
      return exec(`docker build --platform linux/amd64 -f ${arroProfileData.dockerfile} -t ${sRepoName} .`);
    }).then(() => {
      spinner.message(`Tagging image '${tag}' from docker file '${arroProfileData.dockerfile}'`);

      return exec(`docker tag ${sRepoName} ${sImage}`);
    })
    .then(() => {
      spinner.message(`Pushing image '${tag}' from docker file '${arroProfileData.dockerfile}'`);

      return exec(`docker push ${sImage}`);
    })
    // .then(() => {
    //   spinner.message(`Cleaning up`);
    //   return exec(`docker rmi $(docker images | grep ${tag} | tr -s ' ' | cut -d ' ' -f 3) --force`);
    // })
    .then(() => {
      spinner.stop();
      log(':+1: Docker image pushed successfully.');
    });
};

const getImageTag = (arroProfileData, manual) => (manual ? Promise.resolve(false) : exec('git rev-parse --short HEAD').catch(() => Promise.resolve(false))).then(result => result.stdout).then((result) => {
  if (result) {
    return result.trim();
  }

  return inquirer.prompt([{
    type: 'input',
    name: 'tag',
    message: 'Enter tag:',
    // [a-zA-Z0-9-_.]+
    validate(value) {
      const pass = value.match(/^([a-zA-Z0-9-_.]+)$/i);
      if (pass) {
        return true;
      }

      return 'Invalid value, must validate "[a-zA-Z0-9-_.]+"';
    },
  }]).then(answers => answers.tag);
}).then((tag) => {
  return checkTag(arroProfileData, tag).then((result) => {
    if (result.exists) {
      log(`Image tag ${tag} already exists, please enter another:`);
      return getImageTag(arroProfileData, true);
    }
    return tag;
  });
});

const addEnvVariables = (arroProfileData) => {
  const envVariables = arroProfileData.env || [];

  const fRequest = () => {
    const table = new Table({
      head: ['#', 'Name', 'Value'],
    });

    for (let i = 0; i < envVariables.length; i += 1) {
      table.push([i + 1, envVariables[i].name, envVariables[i].value]);
    }

    console.log(table.toString());

    return inquirer.prompt([{
      type: 'confirm',
      name: 'addenv',
      message: 'Do you want to add an ENV variable?',
      default: false,
    }])
      .then((answers) => {
        if (!answers.addenv) return envVariables;

        return inquirer.prompt([{
          type: 'input',
          name: 'name',
          message: 'ENV variable name',
        }, {
          type: 'input',
          name: 'value',
          message: 'ENV variable value',
        }])
          .then((nameAnswers) => {
            envVariables.push({
              name: nameAnswers.name,
              value: nameAnswers.value,
            });
            return fRequest();
          });
      });
  };

  return fRequest().then(() => ({
    env: envVariables,
  }));
};

const deploy = (arroProfileData) => {
  log(':rocket: Starting deployement');
  let sTag = false;

  return fileExists(`${cwd}/${arroProfileData.dockerfile}`)
    .catch(() => Promise.reject(new Error(`${arroProfileData.dockerfile} not found, please create it. Exiting.`)))
    .then(() => getImageTag(arroProfileData))
    .then((tag) => {
      sTag = tag;
      return checkLogGroup(arroProfileData);
    })
    .then((result) => {
      if (result.created) {
        log(':cyclone: AWS log group not existant. Creating...');
        log(`:+1: AWS log group ${arroProfileData.log} successfully created`);
      } else {
        log('AWS log group already created.');
      }
      return rebuildNPM(arroProfileData);
    })
    .then(() => buildImage(arroProfileData, sTag))
    .then(() => {
      if (!arroProfileData.task) {
        log(':cyclone: No task definition to update');
        return Promise.resolve(true);
      }
      log(`:cyclone: Updating task definition ${arroProfileData.task}`);
      return updateService(arroProfileData, sTag, arroProfileData.region);
    })
    .then(() => {
      log(':white_check_mark: Successfully deployed.');
      return true;
    });
};

const events = (arroProfileData) => {
  log(`:fire: '${arroProfileData.service.split('service/')[1]}' service events`);
  const spinner = new Spinner('Retrieving events. Please wait...', ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']);
  spinner.start();

  return getServiceData(arroProfileData)
    .then((data) => {
      const tableObj = new Table();

      for (let i = data.services[0].events.length - 1; i >= 0; i -= 1) {
        const oEvent = data.services[0].events[i];
        tableObj.push([colors.red(timeAgo(new Date(oEvent.createdAt))), oEvent.message]);
      }
      spinner.stop();
      console.log(tableObj.toString());
      return true;
    });
};


const openLogsInBrowser = (arroProfileData) => {
  const region = arroProfileData.region || 'us-east-1';
  const logGroup = encodeURIComponent(arroProfileData.log);

  // Construct CloudWatch Logs URL
  const url = `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/${logGroup}`;

  log(`:globe_with_meridians: Opening CloudWatch logs in browser...`);
  log(`Log Group: ${arroProfileData.log}`);
  log(`URL: ${url}`);

  // Determine the command to open browser based on OS
  const platform = process.platform;
  let command;
  // Escape dollar signs for shell to prevent variable expansion
  const escapedUrl = url.replace(/\$/g, '\\$');

  if (platform === 'darwin') {
    command = `open "${escapedUrl}"`;
  } else if (platform === 'win32') {
    command = `start "${escapedUrl}"`;
  } else {
    // Linux and others
    command = `xdg-open "${escapedUrl}"`;
  }

  return exec(command)
    .then(() => {
      log(':white_check_mark: Browser opened successfully');
      return true;
    })
    .catch((error) => {
      log(`:bangbang: Failed to open browser: ${error.message}`);
      log(`:information_source: Please open this URL manually: ${url}`);
      return false;
    });
};

const openLogsTailInBrowser = async (arroProfileData) => {
  const region = arroProfileData.region || 'us-east-1';
  const logGroup = encodeURIComponent(arroProfileData.log);

  try {
    // Get AWS Account ID
    const accountId = await getAccountId();

    // Construct CloudWatch Live Tail URL with proper ARN including account ID
    const url = `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:live-tail$3FlogGroupArns$3D~(~'arn*3aaws*3alogs*3a${region}*3a${accountId}*3alog-group*3a${logGroup})`;

    log(`:globe_with_meridians: Opening CloudWatch Live Tail in browser...`);
    log(`Log Group: ${arroProfileData.log}`);
    log(`URL: ${url}`);

    // Determine the command to open browser based on OS
    const platform = process.platform;
    let command;
    // Escape dollar signs for shell to prevent variable expansion
    const escapedUrl = url.replace(/\$/g, '\\$');

    if (platform === 'darwin') {
      command = `open "${escapedUrl}"`;
    } else if (platform === 'win32') {
      command = `start "${escapedUrl}"`;
    } else {
      // Linux and others
      command = `xdg-open "${escapedUrl}"`;
    }

    return exec(command)
      .then(() => {
        log(':white_check_mark: Browser opened successfully with Live Tail');
        return true;
      })
      .catch((error) => {
        log(`:bangbang: Failed to open browser: ${error.message}`);
        log(`:information_source: Please open this URL manually: ${url}`);
        return false;
      });
  } catch (error) {
    log(`:bangbang: Failed to get AWS account ID: ${error.message}`);
    return false;
  }
};

const tail = (arroProfileData) => {
  // Check if --browser flag is set
  if (argv.browser || argv.b) {
    return openLogsTailInBrowser(arroProfileData);
  }

  log(`:fire: Tailing logs for '${arroProfileData.service ? arroProfileData.service.split('service/')[1] : arroProfileData.task}'`);
  log(':information_source: Press Ctrl+C to stop tailing');
  log('');

  let lastTimestamp = Date.now();
  let isFirstFetch = true;

  const fetchAndDisplayLogs = () => {
    return getLogStreams(arroProfileData.log)
      .then((arrsStreams) => {
        if (!arrsStreams || arrsStreams.length === 0) {
          return [];
        }

        arrsStreams.reverse();
        const arroPromises = [];

        // Only get recent logs
        const oneMinuteAgo = Date.now() - (60 * 1000);
        const startTime = isFirstFetch ? oneMinuteAgo : lastTimestamp;

        for (let i = 0; i < Math.min(arrsStreams.length, 3); i += 1) {
          arroPromises.push(getLogEvents(arroProfileData.log, arrsStreams[i], Math.floor(startTime / 1000)));
        }

        return Promise.all(arroPromises);
      })
      .then((arroData) => {
        const logs = [];

        for (let i = 0; i < arroData.length; i += 1) {
          Object.keys(arroData[i]).forEach((key) => {
            const timestamp = parseInt(key);
            if (timestamp > lastTimestamp) {
              const arrsMessage = arroData[i][key];
              const oDate = new Date();
              oDate.setTime(timestamp);
              logs.push({
                timestamp,
                date: oDate,
                message: arrsMessage.join('\n'),
              });
            }
          });
        }

        // Sort by timestamp
        logs.sort((a, b) => a.timestamp - b.timestamp);

        // Display new logs
        logs.forEach((log) => {
          const timeStr = timeAgo(log.date);
          const message = log.message;

          // Color code based on log level
          if (message.match(/ERROR|FATAL|CRITICAL/i)) {
            console.log(`${colors.red(timeStr)}:\t${colors.red(message)}`);
          } else if (message.match(/WARN|WARNING/i)) {
            console.log(`${colors.yellow(timeStr)}:\t${colors.yellow(message)}`);
          } else if (message.match(/INFO|SUCCESS/i)) {
            console.log(`${colors.green(timeStr)}:\t${message}`);
          } else {
            console.log(`${colors.blue(timeStr)}:\t${message}`);
          }

          lastTimestamp = Math.max(lastTimestamp, log.timestamp);
        });

        isFirstFetch = false;
      })
      .catch((error) => {
        if (!isFirstFetch) {
          console.error(colors.red(`Error fetching logs: ${error.message}`));
        }
      });
  };

  // Initial fetch
  fetchAndDisplayLogs().then(() => {
    // Continue fetching every 2 seconds
    const interval = setInterval(() => {
      fetchAndDisplayLogs();
    }, 2000);

    // Handle Ctrl+C gracefully
    process.on('SIGINT', () => {
      clearInterval(interval);
      log('\n:wave: Stopped tailing logs');
      process.exit(0);
    });
  });
};

const logs = (arroProfileData) => {
  // Check if --browser flag is set
  if (argv.browser || argv.b) {
    return openLogsInBrowser(arroProfileData);
  }

  log(`:fire: '${arroProfileData.service.split('service/')[1]}' service logs`);
  const spinner = new Spinner('Retrieving logs. Please wait...', ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']);
  spinner.start();

  return getLogStreams(arroProfileData.log)
    .then((arrsStreams) => {
      arrsStreams.reverse();
      const arroPromises = [];
      for (let i = 0; i < arrsStreams.length; i += 1) {
        arroPromises.push(getLogEvents(arroProfileData.log, arrsStreams[i]));
      }

      Promise.all(arroPromises)
        .then((arroData) => {
          const tableObj = new Table();

          for (let i = 0; i < arroData.length; i += 1) {
            tableObj.push([{
              colSpan: 2,
              content: colors.green('Log stream'),
            }]);

            Object.keys(arroData[i]).forEach((key) => {
              const arrsMessage = arroData[i][key];
              const oDate = new Date();
              oDate.setTime(key);
              tableObj.push([colors.red(timeAgo(oDate)), arrsMessage.join('\n')]);
            });
          }

          spinner.stop();
          console.log(tableObj.toString());
        });
    });
};

const check = (arroProfileData) => {
  log(':fire: Checking configuration settings');
  return Promise.resolve()
    .then(() => {
      stdout('- Docker installation ');

      return commandExists('docker')
        .then(() => {
          stdout(':heavy_check_mark: \n');
          return true;
        }).catch(() => Promise.reject(new Error('Docker is not installed. Please go to https://docs.docker.com/engine/installation/')));
    })
    .then(() => {
      stdout('- AWS profile ');
      return loadAWSProfile(arroProfileData)
        .then(() => {
          stdout(':heavy_check_mark: \n');
          return true;
        });
    })
    .then(() => {
      stdout('- dockerfile exists ');
      return fileExists(`${cwd}/${arroProfileData.dockerfile}`)
        .then(() => {
          stdout(':heavy_check_mark: \n');
        });
    })
    .then(() => {
      stdout('- repo exists ');

      const sRepo = arroProfileData.repo.split('amazonaws.com/')[1];
      return checkDockerRepo(sRepo)
        .then(() => {
          stdout(':heavy_check_mark: \n');
          return true;
        })
        .catch(() => Promise.reject(new Error(`Could not find repository '${sRepo}'`)));
    })
    .then(() => {
      stdout('- task definition exists ');

      return checkTaskDefinition(arroProfileData.task)
        .then(() => {
          stdout(':heavy_check_mark: \n');
          return true;
        })
        .catch(() => Promise.reject(new Error(`Could not find task definition '${arroProfileData.task}'`)));
    })
    .then(() => {
      stdout('- cluster exists ');

      return checkCluster(arroProfileData.cluster)
        .then((data) => {
          if (!data.clusters.length) return Promise.reject(new Error('No cluster found'));

          stdout(':heavy_check_mark: \n');
          return true;
        })
        .catch(() => Promise.reject(new Error(`Could not find cluster '${arroProfileData.cluster.split('cluster/')[1]}'`)));
    })
    .then(() => {
      stdout('- service exists ');

      return checkService(arroProfileData.cluster, arroProfileData.task)
        .then((data) => {
          if (!data.services.length) return Promise.reject(new Error('No service found'));

          stdout(':heavy_check_mark: \n');
          return true;
        })
        .catch(() => Promise.reject(new Error(`Could not find service '${arroProfileData.task}'`)));
    })
    .then(() => log(':+1: All checks validated.'))
    .catch((err) => {
      log(`:bangbang:  ${err}`);
      return process.exit();
    });
};

const rebuild = (oProfile) => {
  const sImage = (`${oProfile.profile}/${oProfile.task}/${oProfile.dockerfile}:ecs-aws`).toLowerCase();

  return Promise.resolve()
    .then(() => {
      childProcess.execSync(`docker image remove '${sImage}' --force`, {
        stdio: 'inherit',
      });
      return true;
    })
    .then(() => {
      log(`:arrow_forward:  Rebuilding container image ${sImage}. Creating from '${oProfile.dockerfile}'.`);
      childProcess.spawnSync('docker', (`build -t ${sImage} -f ${oProfile.dockerfile} .`).split(' '), {
        stdio: 'inherit',
      });
      return true;
    })
    .then(() => log(':+1: Image successfully rebuilt.'));
};

const view = (arroProfileData) => {
  const description = {
    env: 'Environment variables',
    local_port: 'Local port',
    app_port: 'App port',
    host_port: 'Host port',
    cpu_units: 'CPU units',
    container_memory: 'Memory (MB)',
    log: 'Cloudwatch log',
    service: 'Service ARN',
    task: 'Task name',
    cluster: 'Cluster ARN',
    repo: 'Repository URL',
    profile: 'AWS Profile',
    dockerfile: 'Docker file path',
    region: 'Region',
  };


  const table = new Table({
    head: ['Name', 'Value'],
  });

  Object.keys(arroProfileData).forEach((key) => {
    if (key === 'env') {
      const tableObj = new Table({
        head: ['#', 'Name', 'Value'],
      });

      for (let i = 0; i < arroProfileData[key].length; i += 1) {
        tableObj.push([i + 1, arroProfileData[key][i].name, arroProfileData[key][i].value]);
      }

      table.push([description[key] || key, tableObj.toString()]);
    } else if (description[key]) {
      table.push([description[key] || key, arroProfileData[key]]);
    }
  });

  return console.log(table.toString());
};

const createNewService = (arroProfileData) => {
  log(':rocket: Creating new ECS service');

  // Check if user has the required permissions
  return checkCreatePermissions()
    .then((permissionResult) => {
      if (permissionResult.warning) {
        log(`:warning: ${permissionResult.warning}`);
      }

      if (!permissionResult.allowed && permissionResult.deniedActions.length > 0) {
        log(':bangbang: You do not have sufficient permissions to create services.');
        log('Missing permissions:');
        permissionResult.deniedActions.forEach(action => log(`  - ${action}`));
        log('');
        log(':information_source: Please contact your AWS administrator to grant these permissions.');
        return Promise.reject(new Error('Insufficient permissions'));
      }

      log(':white_check_mark: Permission check passed\n');
      return Promise.resolve();
    })
    .then(() => {
      let serviceName;
      let ecrRepo;
      let taskDefArn;
      let targetGroupArn;
      let serviceArn;
      let listenerRuleArn;
      let logGroupCreated = false;
      let collectedData = {};

      // Rollback function to clean up created resources
      const rollbackResources = async (errorMessage) => {
        log('\n:warning: Error occurred. Rolling back created resources...\n');

        const resourcesToCleanup = [];

        // Build list of resources to delete (in reverse order of creation)
        if (serviceArn) {
          resourcesToCleanup.push({
            name: 'ECS Service',
            action: () => deleteECSService(arroProfileData.cluster, serviceName),
          });
        }

        if (listenerRuleArn) {
          resourcesToCleanup.push({
            name: 'Listener Rule',
            action: () => deleteListenerRule(listenerRuleArn),
          });
        }

        if (targetGroupArn) {
          resourcesToCleanup.push({
            name: 'Target Group',
            action: () => deleteTargetGroup(targetGroupArn),
          });
        }

        if (taskDefArn) {
          resourcesToCleanup.push({
            name: 'Task Definition',
            action: () => deregisterTaskDefinition(taskDefArn),
          });
        }

        if (logGroupCreated && arroProfileData.log) {
          resourcesToCleanup.push({
            name: 'CloudWatch Log Group',
            action: () => deleteCloudWatchLogGroup(arroProfileData.log),
          });
        }

        if (ecrRepo) {
          resourcesToCleanup.push({
            name: 'ECR Repository',
            action: () => deleteECRRepository(serviceName),
          });
        }

        // Execute cleanup
        for (const resource of resourcesToCleanup) {
          log(`:cyclone: Deleting ${resource.name}...`);
          const success = await resource.action();
          if (success) {
            log(`:white_check_mark: ${resource.name} deleted`);
          } else {
            log(`:warning: Failed to delete ${resource.name} (may need manual cleanup)`);
          }
        }

        log('\n:x: Rollback complete. Original error: ' + errorMessage);
        throw new Error(errorMessage);
      };

      // ===== PHASE 1: COLLECT ALL INFORMATION =====
      log(':information_source: Gathering service configuration...');

      // Ensure Dockerfile is already configured
      if (!arroProfileData.dockerfile) {
        throw new Error('Dockerfile not configured. This should be set during the configure step.');
      }

      // Step 1: Get service name
      return inquirer.prompt([{
        type: 'input',
        name: 'serviceName',
        message: 'Enter service name:',
        validate(value) {
          const done = this.async();

          // Basic format validation
          const formatValid = value.match(/^([a-zA-Z0-9-_]+)$/i);
          if (!formatValid) {
            return done('Invalid service name, must contain only alphanumeric characters, hyphens, and underscores');
          }

          // Check that name doesn't start or end with hyphen/underscore
          if (value.match(/^[-_]|[-_]$/)) {
            return done('Service name cannot start or end with a hyphen or underscore');
          }

          // Check length for target group name (serviceName-tg must be <= 32 chars)
          // Note: underscores will be replaced with hyphens for target group name
          const tgName = `${value.replace(/_/g, '-')}-tg`;
          if (tgName.length > 32) {
            return done(`Service name too long. "${tgName}" exceeds 32 characters. Max service name length: ${32 - 3} characters`);
          }

          // Check if ECR repository already exists
          checkDockerRepo(value)
            .then(() => {
              return done(`ECR repository "${value}" already exists. Please choose a different name or use the existing repository.`);
            })
            .catch(() => {
              // Repository doesn't exist, which is what we want
              return done(null, true);
            });
        },
      }])
        .then((answers) => {
          serviceName = answers.serviceName;
          collectedData.serviceName = serviceName;
          log(`:white_check_mark: Service name "${serviceName}" is available`);

          // Step 2: Get task definition parameters
          log('Task definition configuration:');
          return inquirer.prompt([{
            type: 'input',
            default: 128,
            name: 'container_memory',
            message: 'Container memory (MB):',
            filter: Number,
            validate(value) {
              const num = Number(value);
              if (isNaN(num) || num < 4) {
                return 'Memory must be at least 4 MB';
              }
              if (num > 30720) {
                return 'Memory cannot exceed 30720 MB (30 GB)';
              }
              return true;
            },
          }, {
            type: 'input',
            default: 0,
            name: 'cpu_units',
            message: 'CPU units:',
            filter: Number,
            validate(value) {
              const num = Number(value);
              if (isNaN(num) || num < 0) {
                return 'CPU units must be 0 or greater';
              }
              return true;
            },
          }, {
            type: 'input',
            default: 8080,
            name: 'app_port',
            message: 'Application container port:',
            filter: Number,
            validate(value) {
              const num = Number(value);
              if (isNaN(num) || num < 1 || num > 65535) {
                return 'Port must be between 1 and 65535';
              }
              return true;
            },
          }]);
        })
        .then((answers) => {
          _.extend(collectedData, answers);
          return addEnvVariables(arroProfileData);
        })
        .then((answers) => {
          collectedData.env = answers.env || [];

          // Step 3: Load balancer configuration
          log(':cyclone: Loading load balancers...');
          return loadLoadBalancers();
        })
        .then((loadBalancers) => {
          if (!loadBalancers.length) {
            return Promise.reject(new Error('No Application Load Balancers found. Please create an ALB first.'));
          }

          return inquirer.prompt([{
            type: 'list',
            name: 'loadBalancerArn',
            message: 'Select Application Load Balancer:',
            choices: loadBalancers
              .filter(lb => lb.Type === 'application')
              .map(lb => ({
                name: `${lb.LoadBalancerName} (${lb.DNSName})`,
                value: lb.LoadBalancerArn,
              })),
          }])
            .then((lbAnswer) => {
              collectedData.loadBalancerArn = lbAnswer.loadBalancerArn;
              // Store LB details for later use
              const selectedLb = loadBalancers.find(lb => lb.LoadBalancerArn === lbAnswer.loadBalancerArn);
              collectedData.vpcId = selectedLb ? selectedLb.VpcId : null;
              collectedData.loadBalancerDNSName = selectedLb ? selectedLb.DNSName : null;
              collectedData.loadBalancerHostedZoneId = selectedLb ? selectedLb.CanonicalHostedZoneId : null;
              return lbAnswer.loadBalancerArn;
            });
        })
        .then((loadBalancerArn) => {
          log(':cyclone: Loading listeners...');
          return loadListeners(loadBalancerArn);
        })
        .then((listeners) => {
          if (!listeners.length) {
            return Promise.reject(new Error('No listeners found on the selected load balancer. Please create a listener first.'));
          }

          return inquirer.prompt([{
            type: 'list',
            name: 'listenerArn',
            message: 'Select listener:',
            choices: listeners.map(listener => ({
              name: `Port ${listener.Port} (${listener.Protocol})`,
              value: listener.ListenerArn,
            })),
          }]);
        })
        .then((listenerAnswer) => {
          collectedData.listenerArn = listenerAnswer.listenerArn;

          return inquirer.prompt([{
            type: 'input',
            name: 'healthCheckPath',
            message: 'Health check path:',
            default: '/',
            validate(value) {
              if (!value || value.length === 0) {
                return 'Health check path cannot be empty';
              }
              if (!value.startsWith('/')) {
                return 'Health check path must start with /';
              }
              if (value.length > 1024) {
                return 'Health check path cannot exceed 1024 characters';
              }
              return true;
            },
          }]);
        })
        .then((healthAnswer) => {
          collectedData.healthCheckPath = healthAnswer.healthCheckPath;

          // Step 4: Configure hostname routing (optional)
          return inquirer.prompt([{
            type: 'confirm',
            name: 'useHostname',
            message: 'Do you want to configure hostname routing?',
            default: false,
          }]);
        })
        .then((hostnameAnswer) => {
          if (!hostnameAnswer.useHostname) {
            collectedData.useHostname = false;
            return Promise.resolve();
          }

          return inquirer.prompt([{
            type: 'input',
            name: 'hostname',
            message: 'Enter hostname (e.g., api.example.com):',
            validate(value) {
              if (!value || value.length === 0) {
                return 'Hostname cannot be empty';
              }
              // Basic hostname validation
              const hostnameRegex = /^(\*\.)?([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
              if (!hostnameRegex.test(value)) {
                return 'Invalid hostname format. Use format like: api.example.com or *.example.com';
              }
              if (value.length > 128) {
                return 'Hostname cannot exceed 128 characters';
              }
              return true;
            },
          }])
            .then((hostnameInput) => {
              collectedData.useHostname = true;
              collectedData.hostname = hostnameInput.hostname;
            });
        })
        .then(() => {
          // Step 5: Get desired task count
          return inquirer.prompt([{
            type: 'input',
            name: 'desiredCount',
            message: 'Desired number of tasks:',
            default: 1,
            filter: Number,
            validate(value) {
              const num = Number(value);
              if (isNaN(num) || num < 0) {
                return 'Desired count must be 0 or greater';
              }
              if (num > 10000) {
                return 'Desired count cannot exceed 10000';
              }
              return true;
            },
          }]);
        })
        .then((countAnswer) => {
          collectedData.desiredCount = countAnswer.desiredCount;

          // ===== PHASE 2: CREATE ALL RESOURCES =====
          // Calculate total steps (5 base steps + optional hostname routing)
          const totalSteps = collectedData.useHostname ? 6 : 5;
          let currentStep = 0;

          log('\n:rocket: Creating AWS resources...\n');

          // Step 1: Create ECR repository
          currentStep++;
          log(`[${currentStep}/${totalSteps}] Creating ECR repository: ${serviceName}`);
          return createECRRepository(serviceName);
        })
        .then((repository) => {
          ecrRepo = repository;
          log(`:white_check_mark: ECR repository created`);
          log(`    URI: ${repository.repositoryUri}\n`);
          _.extend(arroProfileData, {
            repo: repository.repositoryUri,
            task: serviceName,
            container_memory: collectedData.container_memory,
            cpu_units: collectedData.cpu_units,
            app_port: collectedData.app_port,
            env: collectedData.env,
          });

          // Step 2: Create log group
          arroProfileData.log = `/ecs/${serviceName}`;
          const totalSteps = collectedData.useHostname ? 6 : 5;
          log(`[2/${totalSteps}] Creating CloudWatch log group: ${arroProfileData.log}`);
          return checkLogGroup(arroProfileData);
        })
        .then((result) => {
          if (result.created) {
            logGroupCreated = true; // Track for rollback
            log(`:white_check_mark: CloudWatch log group created`);
            log(`    Name: ${arroProfileData.log}\n`);
          } else {
            log(`:information_source: CloudWatch log group already exists\n`);
          }

          // Step 2.5: Build and push Docker image
          log(':cyclone: Building and pushing Docker image...');
          return getImageTag(arroProfileData).then(tag => {
            return buildImage(arroProfileData, tag).then(() => tag);
          });
        })
        .then((imageTag) => {
          // Step 3: Create task definition
          const totalSteps = collectedData.useHostname ? 6 : 5;
          log(`[3/${totalSteps}] Creating task definition: ${serviceName}`);

          const taskDefParams = {
            family: serviceName,
            networkMode: 'bridge',
            containerDefinitions: [{
              name: serviceName,
              image: `${ecrRepo.repositoryUri}:${imageTag}`,
              memory: collectedData.container_memory,
              cpu: collectedData.cpu_units,
              essential: true,
              environment: collectedData.env,
              portMappings: [{
                containerPort: collectedData.app_port,
                hostPort: 0, // Dynamic port mapping for bridge mode
                protocol: 'tcp',
              }],
              logConfiguration: {
                logDriver: 'awslogs',
                options: {
                  'awslogs-group': arroProfileData.log,
                  'awslogs-region': arroProfileData.region,
                  'awslogs-stream-prefix': 'ecs',
                },
              },
            }],
          };

          return createTaskDefinitionForNewService(taskDefParams);
        })
        .then((taskDefinition) => {
          taskDefArn = taskDefinition.taskDefinitionArn;
          log(`:white_check_mark: Task definition created: ${taskDefinition.family}:${taskDefinition.revision}`);
          log(`    ARN: ${taskDefArn}\n`);

          // Step 4: Create target group
          const totalSteps = collectedData.useHostname ? 6 : 5;
          // Replace underscores with hyphens for target group name (AWS requirement)
          const targetGroupName = `${serviceName.replace(/_/g, '-')}-tg`.substring(0, 32);
          log(`[4/${totalSteps}] Creating target group: ${targetGroupName}`);
          const targetGroupParams = {
            Name: targetGroupName,
            Protocol: 'HTTP',
            Port: 80,
            VpcId: collectedData.vpcId,
            TargetType: 'instance',
            HealthCheckEnabled: true,
            HealthCheckPath: collectedData.healthCheckPath,
            HealthCheckIntervalSeconds: 30,
            HealthCheckTimeoutSeconds: 5,
            HealthyThresholdCount: 2,
            UnhealthyThresholdCount: 2,
          };

          return createTargetGroup(targetGroupParams);
        })
        .then((targetGroup) => {
          targetGroupArn = targetGroup.TargetGroupArn;
          log(`:white_check_mark: Target group created: ${targetGroup.TargetGroupName}`);
          log(`    ARN: ${targetGroupArn}\n`);

          // Step 5: Create listener rule if hostname routing is configured
          if (!collectedData.useHostname) {
            return Promise.resolve({ skipListenerRule: true });
          }

          log(`[5/6] Creating listener rule for hostname: ${collectedData.hostname}`);
          // Get existing rules to determine priority
          return loadListenerRules(collectedData.listenerArn)
            .then((rules) => {
              // Find the highest priority (lower number = higher priority)
              // Default rule has priority "default", so filter those out
              const numericPriorities = rules
                .map(r => parseInt(r.Priority))
                .filter(p => !isNaN(p));

              const nextPriority = numericPriorities.length > 0
                ? Math.max(...numericPriorities) + 1
                : 1;

              const ruleParams = {
                ListenerArn: collectedData.listenerArn,
                Priority: nextPriority,
                Conditions: [{
                  Field: 'host-header',
                  Values: [collectedData.hostname],
                }],
                Actions: [{
                  Type: 'forward',
                  TargetGroupArn: targetGroupArn,
                }],
              };

              return createListenerRule(ruleParams);
            })
            .then((rule) => {
              listenerRuleArn = rule.RuleArn; // Track for rollback
              log(`:white_check_mark: Listener rule created with priority ${rule.Priority}`);
              log(`    ARN: ${rule.RuleArn}\n`);

              // Create Route53 DNS record
              log(`:cyclone: Creating Route53 DNS record for ${collectedData.hostname}...`);
              return createRoute53Record(
                collectedData.hostname,
                collectedData.loadBalancerDNSName,
                collectedData.loadBalancerHostedZoneId
              );
            })
            .then((route53Result) => {
              if (route53Result.success) {
                log(`:white_check_mark: Route53 DNS record created in hosted zone: ${route53Result.hostedZone}`);
                log(`    Change ID: ${route53Result.changeId}\n`);
              } else {
                log(`:warning: Failed to create Route53 record: ${route53Result.error}`);
                log(`:information_source: You may need to create the DNS record manually\n`);
              }
              return { skipListenerRule: false };
            });
        })
        .then(() => {
          // Step 6 (or 5 if no hostname): Create ECS service
          const totalSteps = collectedData.useHostname ? 6 : 5;
          const currentStep = collectedData.useHostname ? 6 : 5;
          log(`[${currentStep}/${totalSteps}] Creating ECS service: ${serviceName}`);

          const serviceParams = {
            cluster: arroProfileData.cluster,
            serviceName: serviceName,
            taskDefinition: taskDefArn,
            desiredCount: collectedData.desiredCount,
            launchType: 'EC2',
            loadBalancers: [{
              targetGroupArn: targetGroupArn,
              containerName: serviceName,
              containerPort: collectedData.app_port,
            }],
            healthCheckGracePeriodSeconds: 60,
          };

          return createECSService(serviceParams);
        })
        .then((service) => {
          serviceArn = service.serviceArn;
          log(`:white_check_mark: ECS service created: ${service.serviceName}`);
          log(`    ARN: ${serviceArn}\n`);

          // Update profile data with service info
          _.extend(arroProfileData, {
            service: serviceArn,
            host_port: 0,
            local_port: collectedData.app_port,
            loadBalancerArn: collectedData.loadBalancerArn,
            listenerArn: collectedData.listenerArn,
          });

          // Wait for service to be running
          log(':hourglass: Waiting for service to become stable (this may take a few minutes)...');
          return waitForServiceRunning(arroProfileData.cluster, serviceName);
        })
        .then((isRunning) => {
          if (isRunning) {
            log(':white_check_mark: Service is now running!');
          } else {
            log(':warning: Service created but may not be stable yet. Check the AWS console for details.');
          }

          return arroProfileData;
        })
        .catch((err) => {
          // Trigger rollback on any error during resource creation (except permission check failure)
          if (err.message === 'Insufficient permissions') {
            throw err;
          }
          return rollbackResources(err.message);
        });
    });
};

const deleteServiceCommand = (arroProfileData) => {
  log(':warning: DELETE SERVICE - This action cannot be undone!');

  // Check permissions
  log(':cyclone: Checking delete permissions...');

  return checkDeletePermissions()
    .then((permissionResult) => {
      if (permissionResult.warning) {
        log(`:warning: ${permissionResult.warning}`);
      }

      if (!permissionResult.allowed && permissionResult.deniedActions.length > 0) {
        log(':bangbang: You do not have sufficient permissions to delete services.');
        log('Missing permissions:');
        permissionResult.deniedActions.forEach(action => log(`  - ${action}`));
        return Promise.reject(new Error('Insufficient permissions'));
      }

      log(':white_check_mark: Permission check passed\n');

      // Show service details
      const table = new Table();
      table.push(['Service', arroProfileData.service || 'N/A']);
      table.push(['Cluster', arroProfileData.cluster || 'N/A']);
      table.push(['Task Definition', arroProfileData.task || 'N/A']);
      table.push(['ECR Repository', arroProfileData.repo || 'N/A']);
      table.push(['Log Group', arroProfileData.log || 'N/A']);
      console.log(table.toString());

      log('\n:bangbang: The following resources will be DELETED:');
      log('  1. ECS Service (scaled to 0, then deleted)');
      log('  2. Task Definition (deregistered)');
      log('  3. Target Group');
      log('  4. Listener Rules (if any)');
      log('  5. CloudWatch Log Group');
      log('  6. ECR Repository (including all images)');
      if (arroProfileData.hostname) {
        log('  7. Route53 DNS Record (if exists)');
      }
      log('');

      // Require user to type service name to confirm
      const serviceName = arroProfileData.service ? arroProfileData.service.split('service/')[1] : arroProfileData.task;

      return inquirer.prompt([{
        type: 'input',
        name: 'confirmation',
        message: `Type the service name "${serviceName}" to confirm deletion:`,
        validate(value) {
          if (value === serviceName) {
            return true;
          }
          return `You must type "${serviceName}" exactly to confirm deletion`;
        },
      }]);
    })
    .then(() => {
      log('\n:cyclone: Starting deletion process...\n');

      // First, get the service data to retrieve the task definition ARN
      let taskDefinitionArn = null;

      const getTaskDefPromise = (arroProfileData.service && arroProfileData.cluster)
        ? getServiceData(arroProfileData)
          .then((data) => {
            if (data.services && data.services[0] && data.services[0].taskDefinition) {
              taskDefinitionArn = data.services[0].taskDefinition;
              log(`:mag: Found task definition: ${taskDefinitionArn}`);
            }
          })
          .catch((err) => {
            log(`:warning: Could not retrieve service data: ${err.message}`);
          })
        : Promise.resolve();

      return getTaskDefPromise.then(() => {
        const deletionSteps = [];

        // Step 1: Delete ECS Service
        if (arroProfileData.service && arroProfileData.cluster) {
          deletionSteps.push({
            name: 'ECS Service',
            action: () => deleteECSService(arroProfileData.cluster, arroProfileData.service.split('service/')[1] || arroProfileData.service),
          });
        }

        // Step 2: Delete Target Group (if exists)
        // Note: We need to store targetGroupArn in config for this to work
        // For now, we'll skip this if not available

        // Step 3: Deregister Task Definition
        if (taskDefinitionArn || arroProfileData.task) {
          deletionSteps.push({
            name: 'Task Definition',
            action: () => deregisterTaskDefinition(taskDefinitionArn || arroProfileData.task),
          });
        }

        // Step 4: Delete CloudWatch Log Group
        if (arroProfileData.log) {
          deletionSteps.push({
            name: 'CloudWatch Log Group',
            action: () => deleteCloudWatchLogGroup(arroProfileData.log),
          });
        }

        // Step 5: Delete ECR Repository
        if (arroProfileData.repo) {
          const repoName = arroProfileData.repo.split('amazonaws.com/')[1];
          if (repoName) {
            deletionSteps.push({
              name: 'ECR Repository',
              action: () => deleteECRRepository(repoName),
            });
          }
        }

        // Step 6: Delete Route53 record (if hostname exists)
        if (arroProfileData.hostname && arroProfileData.loadBalancerDNSName && arroProfileData.loadBalancerHostedZoneId) {
          deletionSteps.push({
            name: 'Route53 DNS Record',
            action: () => deleteRoute53Record(
              arroProfileData.hostname,
              arroProfileData.loadBalancerDNSName,
              arroProfileData.loadBalancerHostedZoneId
            ),
          });
        }

        // Execute deletions
        const totalSteps = deletionSteps.length;
        let currentStep = 0;

        return deletionSteps.reduce((promise, step) => {
          return promise.then(() => {
            currentStep++;
            log(`[${currentStep}/${totalSteps}] Deleting ${step.name}...`);
            return step.action().then((success) => {
              if (success) {
                log(`:white_check_mark: ${step.name} deleted`);
              } else {
                log(`:warning: Failed to delete ${step.name} (may need manual cleanup)`);
              }
            });
          });
        }, Promise.resolve());
      });
    })
    .then(() => {
      log('\n:white_check_mark: Service deletion complete!');
      log(':information_source: Config file still exists. Delete it manually if needed.');

      // Optionally delete config file
      return inquirer.prompt([{
        type: 'confirm',
        name: 'deleteConfig',
        message: 'Do you want to delete the configuration file?',
        default: false,
      }]);
    })
    .then((deleteConfigAnswer) => {
      if (deleteConfigAnswer.deleteConfig) {
        return new Promise((resolve, reject) => {
          fs.unlink(sFileName, (err) => {
            if (err) {
              log(`:warning: Could not delete config file: ${err.message}`);
            } else {
              log(`:white_check_mark: Configuration file ${sFileName} deleted`);
            }
            resolve();
          });
        });
      }
    })
    .catch((err) => {
      if (err.message === 'Insufficient permissions') {
        throw err;
      }
      log(`:bangbang: Error during deletion: ${err.message}`);
      throw err;
    });
};

const configure = arroProfileData => inquirer.prompt([{
  type: 'input',
  name: 'dockerfile',
  message: 'Enter DockerFile name:',
  default: arroProfileData.dockerfile || 'Dockerfile',
  validate(value) {
    const done = this.async();

    fileExists(value)
      .then(() => done(null, true)).catch(() => done(`Could not find DockerFile "${value}"`));

    return done;
  },
}])
  .then((answers) => {
    _.extend(arroProfileData, answers);

    // Load AWS profiles
    log(':cyclone: Loading AWS profiles...');
    const profiles = loadAWSProfiles();

    if (!profiles.length) {
      log(':warning: No AWS profiles found. Please configure AWS CLI first.');
      return Promise.reject(new Error('No AWS profiles configured. Run "aws configure" to set up a profile.'));
    }

    return inquirer.prompt({
      type: 'list',
      name: 'profile',
      message: 'Select AWS Profile:',
      default: arroProfileData.profile || 'default',
      choices: profiles.map(profile => ({
        name: profile,
        value: profile,
      })),
    });
  })
  .then((answers) => {
    _.extend(arroProfileData, answers);
    // Set a default region for initial profile loading
    if (!arroProfileData.region) {
      arroProfileData.region = 'eu-west-1';
    }
    return loadAWSProfile(arroProfileData)
      .catch(() => {
        log(`\n:bangbang:  Could not find profile "${arroProfileData.profile}", please create a profile with "aws configure --profile ${arroProfileData.profile}"`);
        process.exit();
      });
  })
  .then(() => {
    log(':cyclone: Loading Regions ...');
    return loadRegions()
      .catch(() => Promise.reject(new Error('Problem loading regions')));
  })
  .then(regions => inquirer.prompt({
    type: 'list',
    name: 'region',
    message: 'Select region:',
    default: arroProfileData.region || null,
    choices: regions.map(region => ({
      name: region.RegionName,
      value: region.RegionName,
    })).sort(compare),
  }))
  .then((answers) => {
    _.extend(arroProfileData, answers);

    // Reload AWS profile with selected region
    return loadAWSProfile(arroProfileData);
  })
  .then(() => {
    // Ask if user wants to use existing or create new service
    return inquirer.prompt({
      type: 'list',
      name: 'serviceChoice',
      message: 'Do you want to use an existing service or create a new one?',
      choices: [
        {
          name: 'Use existing service',
          value: 'existing',
        },
        {
          name: 'Create new service',
          value: 'new',
        },
      ],
    });
  })
  .then((serviceChoiceAnswer) => {
    if (serviceChoiceAnswer.serviceChoice === 'new') {
      // Ask for service type
      return inquirer.prompt({
        type: 'list',
        name: 'serviceType',
        message: 'Select service type:',
        choices: [
          {
            name: 'API Service',
            value: 'api',
          },
          {
            name: 'Schedule Service (Coming soon)',
            value: 'schedule',
            disabled: true,
          },
        ],
      }).then((serviceTypeAnswer) => {
        if (serviceTypeAnswer.serviceType === 'api') {
          // For API Service, need to select cluster first
          log(':cyclone: Loading ECS clusters ...');
          return loadClusters()
            .catch(() => Promise.reject(new Error('Problem loading clusters')))
            .then(clusters => inquirer.prompt({
              type: 'list',
              name: 'cluster',
              message: 'Select cluster:',
              default: arroProfileData.cluster || null,
              choices: clusters.map(cluster => ({
                name: cluster.split('cluster/')[1],
                value: cluster,
              })).sort(compare),
            }))
            .then((clusterAnswer) => {
              _.extend(arroProfileData, clusterAnswer);
              // Now call createNewService with cluster set
              return createNewService(arroProfileData);
            })
            .then((updatedProfile) => {
              // Save the configuration after service creation
              return new Promise((resolve, reject) => {
                fs.writeFile(sFileName, JSON.stringify(updatedProfile), (err) => {
                  if (err) return reject(new Error('Could not save configuration file.'));
                  log(':white_check_mark: Configuration file saved.');
                  return resolve({ skipRestOfFlow: true });
                });
              });
            });
        }
        // For other service types, continue (though schedule is disabled for now)
        return { skipRestOfFlow: false };
      });
    }
    // User wants to use existing service, continue with normal flow
    return { skipRestOfFlow: false };
  })
  .then((flowControl) => {
    // If we created a new service, stop here
    if (flowControl && flowControl.skipRestOfFlow) {
      return Promise.resolve('completed');
    }

    log(':cyclone: Loading ECR repositories ...');
    return loadRepositories()
      .catch(() => Promise.reject(new Error('Problem loading repositories')));
  })
  .then((result) => {
    // If flow was completed early, stop here
    if (result === 'completed') {
      return Promise.resolve('completed');
    }
    return result;
  })
  .then((repos) => {
    if (repos === 'completed') {
      return Promise.resolve('completed');
    }
    return inquirer.prompt({
      type: 'list',
      name: 'repo',
      message: 'Select repository:',
      default: arroProfileData.repo || null,
      choices: repos.map(repo => ({
        name: repo.repositoryName,
        value: repo.repositoryUri,
      })).sort(compare),
    });
  })
  .then((answers) => {
    if (answers === 'completed') {
      return Promise.resolve('completed');
    }
    _.extend(arroProfileData, answers);

    log(':cyclone: Loading ECS clusters ...');
    return loadClusters()
      .catch(() => Promise.reject(new Error('Problem loading clusters')));
  })
  .then((clusters) => {
    if (clusters === 'completed') {
      return Promise.resolve('completed');
    }
    return inquirer.prompt({
      type: 'list',
      name: 'cluster',
      message: 'Select cluster:',
      default: arroProfileData.cluster || null,
      choices: clusters.map(cluster => ({
        name: cluster.split('cluster/')[1],
        value: cluster,
      })).sort(compare),
    });
  })
  .then((answers) => {
    if (answers === 'completed') {
      return Promise.resolve('completed');
    }
    _.extend(arroProfileData, answers);

    log(':cyclone: Loading ECS task definitions ...');
    return loadTaskDefinitions()
      .catch(() => Promise.reject(new Error('Problem loading task definitions')));
  })
  .then((tasks) => {
    if (tasks === 'completed') {
      return Promise.resolve('completed');
    }
    return inquirer.prompt({
      type: 'list',
      name: 'task',
      message: 'Select task definition:',
      default: arroProfileData.task || null,
      choices: tasks.map(task => ({
        name: task,
        value: task,
      })).sort(compare),
    });
  })
  .then((answers) => {
    if (answers === 'completed') {
      return Promise.resolve('completed');
    }
    _.extend(arroProfileData, answers);

    log(':cyclone: Loading ECS services ...');
    return loadServices(arroProfileData.cluster)
      .catch(() => Promise.reject(new Error('Problem loading services')));
  })
  .then((tasks) => {
    if (tasks === 'completed') {
      return Promise.resolve('completed');
    }
    return inquirer.prompt({
      type: 'list',
      name: 'service',
      message: 'Select service:',
      default: arroProfileData.service || null,
      choices: [{
        name: 'New service',
        value: 'new_service',
      }, {
        name: 'cronjob',
        value: false,
      }].concat(tasks.map(service => ({
        name: service.split('service/')[1],
        value: service,
      })).sort(compare)),
    });
  })
  .then((answers) => {
    if (answers === 'completed') {
      return Promise.resolve('completed');
    }
    // Check if user wants to create a new service
    if (answers.service === 'new_service') {
      return createNewService(arroProfileData)
        .then((updatedProfile) => {
          // Save the configuration after service creation
          return new Promise((resolve, reject) => {
            fs.writeFile(sFileName, JSON.stringify(updatedProfile), (err) => {
              if (err) return reject(new Error('Could not save configuration file.'));
              log(':white_check_mark: Configuration file saved.');
              return resolve(true);
            });
          });
        });
    }

    // Otherwise continue with normal flow
    _.extend(arroProfileData, answers);

    return inquirer.prompt({
      type: 'input',
      default: arroProfileData.log || (arroProfileData.task),
      name: 'log',
      message: 'Log group name:',
    })
      .then((logAnswers) => {
        _.extend(arroProfileData, logAnswers);

        log('Container configuration:');

        return inquirer.prompt([{
          type: 'input',
          default: arroProfileData.container_memory || 128,
          name: 'container_memory',
          message: 'Container memory:',
          filter: Number,
        }, {
          type: 'input',
          default: arroProfileData.cpu_units || 0,
          name: 'cpu_units',
          message: 'CPU units:',
          filter: Number,
        }, {
          type: 'input',
          default: arroProfileData.host_port || 0,
          name: 'host_port',
          message: 'Host port (0 is dynamic port attribution):',
          filter: Number,
        }, {
          type: 'input',
          default: arroProfileData.app_port || 8080,
          name: 'app_port',
          message: 'App port:',
          filter: Number,
        }, {
          type: 'input',
          default: arroProfileData.local_port || 8080,
          name: 'local_port',
          message: 'Local port for testing:',
          filter: Number,
        }]);
      })
      .then((containerAnswers) => {
        _.extend(arroProfileData, containerAnswers);
        return addEnvVariables(arroProfileData);
      })
      .then((envAnswers) => {
        _.extend(arroProfileData, envAnswers);

        return new Promise((resolve, reject) => {
          // Use the global filename if it was set during init, otherwise use sFileName
          const fileNameToSave = global.newConfigFileName || sFileName;
          fs.writeFile(fileNameToSave, JSON.stringify(arroProfileData), (err) => {
            if (err) return reject(new Error('Could not save configuration file.'));
            // Clear the global variable after saving
            delete global.newConfigFileName;
            return resolve(true);
          });
        });
      })
      .then(() => {
        log(':white_check_mark: Configuration file saved.');
      });
  })
  .catch((err) => {
    log(`:bangbang:  ${err}`);
    process.exit();
  });

// Main execution function
(async () => {
  // Determine profile and filename
  let sProfile = '';
  let sFileName = '';

  // Check if -p flag was provided without a value (will be true) or needs selection
  // Skip profile selection for 'init' command as it has its own profile name prompt
  if ((argv.profile === true || argv.profile === '') && argv._.indexOf('init') === -1) {
    // -p flag provided without value, show selection
    try {
      sProfile = await selectECSConfigProfile();
      if (sProfile === 'default') {
        sProfile = '';
      }
      log(`:white_check_mark: Selected profile: ${sProfile || 'default'}`);
    } catch (error) {
      logError(error.message);
      return;
    }
  } else if (typeof argv.profile === 'string' && argv.profile !== '') {
    // -p flag provided with a value
    sProfile = argv.profile;
  }
  // Otherwise sProfile remains empty (default)

  sFileName = `ECSConfig${sProfile ? `_${sProfile}` : ''}.json`;

  if (argv._.indexOf('dash') !== -1) {
    loadConfigFile(sFileName)
      .then(loadAWSProfile)
      .then(dashboard);
  } else if (argv._.indexOf('configure') !== -1) {
    loadConfigFile(sFileName)
      .then(configure)
      .catch(logError);
  } else if (argv._.indexOf('deploy') !== -1) {
    loadConfigFile(sFileName)
      .then(loadAWSProfile)
      .then(deploy)
      .catch(logError);
  } else if (argv._.indexOf('commit') !== -1) {
    loadConfigFile(sFileName)
      .then(loadAWSProfile)
      .then(commit)
      .catch(logError);
  } else if (argv._.indexOf('check') !== -1) {
    loadConfigFile(sFileName)
      .then(check)
      .catch(logError);
  } else if (argv._.indexOf('events') !== -1) {
    loadConfigFile(sFileName)
      .then(loadAWSProfile)
      .then(events)
      .catch(logError);
  } else if (argv._.indexOf('logs') !== -1) {
    loadConfigFile(sFileName)
      .then(loadAWSProfile)
      .then(logs)
      .catch(logError);
  } else if (argv._.indexOf('tail') !== -1) {
    loadConfigFile(sFileName)
      .then(loadAWSProfile)
      .then(tail)
      .catch(logError);
  } else if (argv._.indexOf('info') !== -1) {
    loadConfigFile(sFileName)
      .then(view)
      .catch(logError);
  } else if (argv._.indexOf('init') !== -1) {
    // Ask user for profile name first
    inquirer.prompt([{
      type: 'input',
      name: 'profileName',
      message: 'Enter a name for this configuration profile (leave empty for default):',
      default: '',
      validate(value) {
        // Allow empty for default, otherwise check if name is valid
        if (value && !/^[a-zA-Z0-9_-]+$/.test(value)) {
          return 'Profile name can only contain letters, numbers, hyphens, and underscores.';
        }
        return true;
      }
    }])
      .then(answers => {
        const profileName = answers.profileName.trim();
        const configFileName = `ECSConfig${profileName ? `_${profileName}` : ''}.json`;

        // Check if file already exists
        return fileExists(configFileName)
          .then(() => {
            logError(`Configuration file ${configFileName} already exists, please use --configure to edit it.`);
          })
          .catch(() => {
            // File doesn't exist, proceed with configuration
            log(`:sparkles: Creating new configuration: ${configFileName}`);
            // Store the filename in a variable that configure can access
            global.newConfigFileName = configFileName;
            return configure({});
          });
      })
      .catch(logError);
  } else if (argv._.indexOf('delete-service') !== -1) {
    loadConfigFile(sFileName)
      .then(loadAWSProfile)
      .then(deleteServiceCommand)
      .catch(logError);
  } else if (argv._.indexOf('rebuild') !== -1) {
    loadConfigFile(sFileName)
      .then(rebuild)
      .catch(logError);
  } else if (argv._.indexOf('run') !== -1) {
    let oProfile;
    loadConfigFile(sFileName)
      .then((arroProfileData) => {
        oProfile = arroProfileData;
      }).then(() => {
        const sImage = (`${oProfile.profile}/${oProfile.task}/${oProfile.dockerfile}:ecs-aws`).toLowerCase();
        return exec(`docker images ${sImage}`)
          .then(result => result.stdout.split('\n').length === 3)
          .then((imageExists) => {
            if (imageExists) {
              return true;
            }

            log(`:arrow_forward:  Container image ${sImage} doesn't exists. Creating from '${oProfile.dockerfile}' - this is a one time operation. To rebuild your image run ecs-aws rebuild afterwards.`);
            childProcess.spawnSync('docker', (`build --platform linux/amd64 -t ${sImage} -f ${oProfile.dockerfile} .`).split(' '), {
              stdio: 'inherit',
            });

            return true;
          })
          .then(() => new Promise(((resolve) => {
            log(`:arrow_forward:  Running local container on ${'localhost'}:${oProfile.local_port} with docker image '${sImage}' [${oProfile.container_memory}MB]`);
            const sCMD = `docker run --platform linux/amd64 --shm-size ${oProfile.container_memory}m  --publish ${oProfile.local_port}:${oProfile.app_port} -ti -w /app -v ${process.cwd()}:/app '${sImage}' bash`;
            console.log(sCMD)
            try {
              childProcess.execSync(sCMD, {
                stdio: 'inherit',
              });
              resolve();
            } catch (e) {
              resolve();
            }
          })));
      }).catch((err) => {
        console.log(err)
        log(`:bangbang:  ${err}`);
        process.exit();
      });
  } else {
    let bValidCommand = false;
    loadConfigFile(sFileName)
      .then(loadAWSProfile)
      .then((arroProfileData) => {
        if (argv.c) {
          bValidCommand = true;
          return commit(arroProfileData);
        }

        return arroProfileData;
      })
      .then((arroProfileData) => {
        if (argv.d) {
          bValidCommand = true;
          return deploy(arroProfileData);
        }

        return arroProfileData;
      })
      .then(() => {
        if (!bValidCommand) {
          yargs.showHelp();
        }
      })
      .catch(logError);
  }
})().catch((err) => {
  log(`:bangbang: ${err.message || err}`);
  process.exit(1);
});
