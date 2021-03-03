#! /usr/bin/env node
const inquirer = require('inquirer');
const AWS = require('aws-sdk');
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
const { getServiceData, getLogStreams, getLogEvents } = require('./aws');

// Start arguments
const { argv } = yargs
  .usage('$0 <cmd> [args]')
  .option('profile', {
    alias: 'p',
    describe: 'Profile to work on.',
    demandOption: false,
    default: '',
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
  .command('deploy', 'Deploy the code into ECR & ECS (will use the GIT short hash as version if available)')
  .command('run', 'Run local container.')
  .command('rebuild', 'Rebuild the image container from the Dockerfile.')
  .command('info', 'View a configuration table.')
  .command('events', 'View service events.')
  .command('dash', 'Dashboard (beta)')
  .command('logs', 'View service logs.')
  .command('check', 'Check configuration.')
  .command('configure', 'Change a config file configuration.')
  .command('init', 'Initialise a config file.')
  .help();

const sProfile = argv.profile || '';
const sFileName = `ECSConfig${sProfile ? `_${sProfile}` : ''}.json`;

const cwd = process.cwd();

const log = (sText) => {
  console.log(emoji.emojify(sText));
};

const stdout = (sText) => {
  process.stdout.write(emoji.emojify(sText));
};

const exec = (...args) => MainExec(...args).then(res => res.stdout);


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

const loadAWSProfile = arroProfileData => Promise.resolve()
  .then(() => {
    const creds = new AWS.SharedIniFileCredentials({
      profile: arroProfileData.profile,
    });

    if (!creds.accessKeyId) return Promise.reject(new Error(`Could not find profile "${arroProfileData.profile}"`));

    AWS.config.update({
      region: arroProfileData.region || 'eu-west-1',
    });

    AWS.config.credentials = creds;

    return arroProfileData;
  });

const logError = (err) => {
  log(`:bangbang:  ${err}`);
  return process.exit();
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

const updateService = (arroProfileData, sTag) => {
  if (!arroProfileData.task) {
    log(':cyclone: No task definition to update');
    return Promise.resolve(true);
  }

  const ecs = new AWS.ECS();

  log(`:cyclone: Updating task definition ${arroProfileData.task}`);
  const definition = {
    networkMode: 'bridge',
    family: arroProfileData.task,
    volumes: [],
    containerDefinitions: [{
      environment: arroProfileData.env,
      name: arroProfileData.task,
      image: `${arroProfileData.repo}:${sTag}`,
      memory: arroProfileData.container_memory,
      cpu: arroProfileData.cpu_units,
      mountPoints: [],
      portMappings: [{
        protocol: 'tcp',
        hostPort: arroProfileData.host_port,
        containerPort: arroProfileData.app_port,
      }],
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': arroProfileData.log,
          'awslogs-region': arroProfileData.region || AWS.config.region,
        },
      },
      linuxParameters:{
        sharedMemorySize: arroProfileData.container_memory
      },
      essential: true,
      volumesFrom: []
    }],
  };


  return ecs.registerTaskDefinition(definition).promise()
    .then((data) => {
      const params = {
        service: arroProfileData.service,
        taskDefinition: data.taskDefinition.taskDefinitionArn,
        cluster: arroProfileData.cluster,
      };

      return ecs.updateService(params).promise();
    });
};

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
      const sResult = result.replace('-e none', '');
      return exec(sResult);
    }).then(() => {
      spinner.message(`Building image '${tag}' from docker file '${arroProfileData.dockerfile}'`, ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']);

      return exec(`docker build -f ${arroProfileData.dockerfile} -t ${sRepoName} .`);
    }).then(() => {
      spinner.message(`Tagging image '${tag}' from docker file '${arroProfileData.dockerfile}'`);

      return exec(`docker tag ${sRepoName} ${sImage}`);
    })
    .then(() => {
      spinner.message(`Pushing image '${tag}' from docker file '${arroProfileData.dockerfile}'`);

      return exec(`docker push ${sImage}`);
    })
    .then(() => {
      spinner.message(`Cleaning up`);
      return exec(`docker rmi $(docker images | grep ${tag} | tr -s ' ' | cut -d ' ' -f 3) --force`);
    })
    .then(() => {
      spinner.stop();
      log(':+1: Docker image pushed successfully.');
    });
};

const checkLogGroup = (arroProfileData) => {
  const cloudwatchlogs = new AWS.CloudWatchLogs();
  return cloudwatchlogs.describeLogGroups({}).promise()
    .then((data) => {
      const arroLogs = data.logGroups.filter(oLog => arroProfileData.log === oLog.logGroupName);

      if (!arroLogs.length) {
        log(':cyclone: AWS log group not existant. Creating...');
        const params = {
          logGroupName: arroProfileData.log,
        };
        return cloudwatchlogs.createLogGroup(params).promise().then(() => {
          log(`:+1: AWS log group ${arroProfileData.log} successfully created`);
          return true;
        });
      }
      log('AWS log group already created.');
      return true;
    });
};


const checkTag = (arroProfileData, manual) => (manual ? Promise.resolve(false) : exec('git rev-parse --short HEAD').catch(() => Promise.resolve(false))).then((result) => {
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
  const ecr = new AWS.ECR();
  const params = {
    repositoryName: arroProfileData.repo.split('amazonaws.com/')[1],
    imageIds: [{
      imageTag: tag,
    }],
  };

  return ecr.describeImages(params).promise().then(() => {
    log(`Image tag ${tag} already exists, please enter another:`);
    return checkTag(arroProfileData, true);
  })
    .catch((err) => {
      if (err.code === 'ImageNotFoundException') return Promise.resolve(tag);

      return Promise.reject(err);
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
    .then(() => checkTag(arroProfileData))
    .then((tag) => {
      sTag = tag;
      return checkLogGroup(arroProfileData);
    })
    .then(() => rebuildNPM(arroProfileData))
    .then(() => buildImage(arroProfileData, sTag))
    .then(() => updateService(arroProfileData, sTag))
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


const logs = (arroProfileData) => {
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
      const creds = new AWS.SharedIniFileCredentials({
        profile: arroProfileData.profile,
      });

      if (!creds.accessKeyId) return Promise.reject(new Error(`Could not find profile "${arroProfileData.profile}"`));

      AWS.config.update({
        region: arroProfileData.region || 'eu-west-1',
      });
      AWS.config.credentials = creds;

      stdout(':heavy_check_mark: \n');
      return true;
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

      const ecr = new AWS.ECR();
      const sRepo = arroProfileData.repo.split('amazonaws.com/')[1];
      return ecr.describeRepositories({
        repositoryNames: [sRepo],
      }).promise()
        .then(() => {
          stdout(':heavy_check_mark: \n');
          return true;
        })
        .catch(() => Promise.reject(new Error(`Could not find repository '${sRepo}'`)));
    })
    .then(() => {
      stdout('- task definition exists ');

      const ecs = new AWS.ECS();
      const params = {
        taskDefinition: arroProfileData.task,
      };

      return ecs.describeTaskDefinition(params).promise()
        .then(() => {
          stdout(':heavy_check_mark: \n');
          return true;
        })
        .catch(() => Promise.reject(new Error(`Could not find task definition '${arroProfileData.task}'`)));
    })
    .then(() => {
      stdout('- cluster exists ');

      const ecs = new AWS.ECS();

      const params = {
        clusters: [
          arroProfileData.cluster,
        ],
      };

      return ecs.describeClusters(params).promise()
        .then((data) => {
          if (!data.clusters.length) return Promise.reject(new Error('No cluster found'));

          stdout(':heavy_check_mark: \n');
          return true;
        })
        .catch(() => Promise.reject(new Error(`Could not find cluster '${arroProfileData.cluster.split('cluster/')[1]}'`)));
    })
    .then(() => {
      stdout('- service exists ');

      const ecs = new AWS.ECS();

      const params = {
        cluster: arroProfileData.cluster,
        services: [
          arroProfileData.task,
        ],
      };

      return ecs.describeServices(params).promise()
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
}, {
  type: 'input',
  name: 'profile',
  message: 'Enter AWS Profile you want to use:',
  default: arroProfileData.profile || 'default',
  validate(value) {
    const done = this.async();
    const creds = new AWS.SharedIniFileCredentials({
      profile: value,
    });

    if (creds.accessKeyId) {
      // Needs a region to get started
      AWS.config.update({
        region: 'eu-west-1',
      });

      AWS.config.credentials = creds;
      return done(null, true);
    }
    log(`\n:bangbang:  Could not find profile "${value}", please create a profile with "aws configure --profile ${value}"`);
    process.exit();

    return done;
  },
}])
  .then((answers) => {
    _.extend(arroProfileData, answers);

    const ec2 = new AWS.EC2();
    log(':cyclone: Loading Regions ...');
    return ec2.describeRegions({}).promise()
      .catch(() => Promise.reject(new Error('Problem loading regions')))
      .then((data) => {
        if (!data.Regions || !data.Regions.length) {
          return Promise.reject(new Error('No regions found'));
        }

        return data.Regions;
      });
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

    AWS.config.update({
      region: arroProfileData.region,
    });

    const ecr = new AWS.ECR();
    log(':cyclone: Loading ECR repositories ...');
    return ecr.describeRepositories({
      maxResults: 100,
    }).promise()
      .catch(() => Promise.reject(new Error('Problem loading repositories')))
      .then((data) => {
        if (!data.repositories || !data.repositories.length) {
          return Promise.reject(new Error('No repositories found'));
        }

        return data.repositories;
      });
  })
  .then(repos => inquirer.prompt({
    type: 'list',
    name: 'repo',
    message: 'Select repository:',
    default: arroProfileData.repo || null,
    choices: repos.map(repo => ({
      name: repo.repositoryName,
      value: repo.repositoryUri,
    })).sort(compare),
  }))
  .then((answers) => {
    _.extend(arroProfileData, answers);

    const ecs = new AWS.ECS();
    log(':cyclone: Loading ECS clusters ...');
    return ecs.listClusters({
      maxResults: 100,
    }).promise()
      .catch(() => Promise.reject(new Error('Problem loading clusters')))
      .then((data) => {
        if (!data.clusterArns || !data.clusterArns.length) {
          return Promise.reject(new Error('No clusters found'));
        }

        return data.clusterArns;
      });
  })
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
  .then((answers) => {
    _.extend(arroProfileData, answers);

    const ecs = new AWS.ECS();
    log(':cyclone: Loading ECS task definitions ...');
    return ecs.listTaskDefinitionFamilies({
      maxResults: 100,
    }).promise()
      .then(data => data.families)
      .catch(() => Promise.reject(new Error('Problem loading task definitions')));
  })
  .then(tasks => inquirer.prompt({
    type: 'list',
    name: 'task',
    message: 'Select task definition:',
    default: arroProfileData.task || null,
    choices: tasks.map(task => ({
      name: task,
      value: task,
    })).sort(compare),
  }))
  .then((answers) => {
    _.extend(arroProfileData, answers);

    const ecs = new AWS.ECS();
    log(':cyclone: Loading ECS services ...');
    return ecs.listServices({
      maxResults: 100,
      cluster: arroProfileData.cluster,
    }).promise()
      .then(data => data.serviceArns)
      .catch(() => Promise.reject(new Error('Problem loading services')));
  })
  .then(tasks => inquirer.prompt({
    type: 'list',
    name: 'service',
    message: 'Select service:',
    default: arroProfileData.service || null,
    choices: [{
      name: 'cronjob',
      value: false,
    }].concat(tasks.map(service => ({
      name: service.split('service/')[1],
      value: service,
    })).sort(compare)),
  }))
  .then((answers) => {
    _.extend(arroProfileData, answers);

    return inquirer.prompt({
      type: 'input',
      default: arroProfileData.log || (arroProfileData.task),
      name: 'log',
      message: 'Log group name:',
    });
  })
  .then((answers) => {
    _.extend(arroProfileData, answers);

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
  .then((answers) => {
    _.extend(arroProfileData, answers);

    return addEnvVariables(arroProfileData);
  })
  .then((answers) => {
    _.extend(arroProfileData, answers);

    return new Promise((resolve, reject) => fs.writeFile(sFileName, JSON.stringify(arroProfileData), (err) => {
      if (err) return reject(new Error('Could not save configuration file.'));

      return resolve(true);
    }));
  })
  .then(() => {
    log(':white_check_mark: Configuration file saved.');
  })
  .catch((err) => {
    log(`:bangbang:  ${err}`);
    process.exit();
  });

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
} else if (argv._.indexOf('info') !== -1) {
  loadConfigFile(sFileName)
    .then(view)
    .catch(logError);
} else if (argv._.indexOf('init') !== -1) {
  fileExists(sFileName)
    .then(() => {
      logError(`Configuration file ${sFileName} already exists, please use --configure to edit it.`);
    })
    .catch(() => {
      configure({});
    });
} else if (argv._.indexOf('rebuild') !== -1) {
  loadConfigFile(sFileName)
    .then(rebuild)
    .catch(logError);
} else if (argv._.indexOf('run') !== -1) {
  let oProfile;
  loadConfigFile(sFileName)
    .then((arroProfileData) => {
      oProfile = arroProfileData;
      return exec('docker-machine ip');
    }).then((ip) => {
      const sImage = (`${oProfile.profile}/${oProfile.task}/${oProfile.dockerfile}:ecs-aws`).toLowerCase();

      return exec(`docker images ${sImage}`)
        .then(result => result.split('\n').length === 3)
        .then((imageExists) => {
          if (imageExists) {
            return true;
          }
          log(`:arrow_forward:  Container image ${sImage} doesn't exists. Creating from '${oProfile.dockerfile}' - this is a one time operation. To rebuild your image run ecs-aws rebuild afterwards.`);
          childProcess.spawnSync('docker', (`build -t ${sImage} -f ${oProfile.dockerfile} .`).split(' '), {
            stdio: 'inherit',
          });
          return true;
        })
        .then(() => new Promise(((resolve) => {
          log(`:arrow_forward:  Running local container on ${ip.trim()}:${oProfile.local_port} with docker image '${sImage}' [${oProfile.container_memory}MB]`);
          const sCMD = `docker run --shm-size ${oProfile.container_memory}m  --publish ${oProfile.local_port}:${oProfile.app_port} -ti -w /app -v ${process.cwd()}:/app '${sImage}' bash`;
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
