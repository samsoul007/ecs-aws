#! /usr/bin/env node

var inquirer = require('inquirer');
var AWS = require("aws-sdk");
var fs = require("fs");
var Promise = require("bluebird");
var _ = require("lodash");
var yargs = require('yargs');
var emoji = require('node-emoji');
const promisify = require('util.promisify');
const exec = promisify(require('child_process').exec);
const child_process = require('child_process');
const spawn = require('child_process').spawn
var Table = require('cli-table2');
var commandExists = require('command-exists');
var timeAgo = require('node-time-ago');
var colors = require("colors")

var CLI = require('clui'),
    Spinner = CLI.Spinner;

var cwd = process.cwd()

var log = function(p_sText){
  console.log(emoji.emojify(p_sText))
}

var stdout= function(p_sText){
  process.stdout.write(emoji.emojify(p_sText))
}


var spawnP = function(cmd,verbose){
  return new Promise(function(resolve,reject){
    var options = {
      shell: true
    }

    if(verbose)
      options.stdio = "inherit";

    var depChild = spawn(cmd, options)

    depChild.on('exit', (data) => {
      resolve();
    })
  })
}

var compare = function(a,b) {
  if (a.name < b.name)
    return -1;
  if (a.name > b.name)
    return 1;
  return 0;
}

var fileExists = function(path){
  return new Promise(function(resolve,reject){
    fs.stat(path, function(err, stat) {
      if(err) {
        reject(err);
      }

      resolve(true);
    });
  })
}

var loadFile = function(path){
  return new Promise(function(resolve,reject){
    try {
      var arroProfileData = require(cwd+"/"+sFileName);
    }
    catch (e) {
     return reject(e);
    }

    return resolve(arroProfileData);
  })
}

// var arroProfileData = {};

var commit = function(arroProfileData){
  log(':fire: Commit your code.');

  return fileExists(cwd+"/.git")
  .catch(function(){
    return Promise.reject("Not a git repository (or any of the parent directories).")
  })
  .then(function(){
    return inquirer.prompt([{
        type: 'input',
        name: 'commit',
        message: 'Enter commit text:'
      }
    ])
    .then(function(answers){
      spinner = new Spinner("Commiting your code. Please wait...", ['⣾','⣽','⣻','⢿','⡿','⣟','⣯','⣷']);
      spinner.start();

      return exec("git add .")
      .then(function(res){
        return exec("git commit -m '" + answers.commit+ "'");
      })
      .then(function(){
        return exec("git push origin master;");
      })
      .then(function(){
        spinner.stop();
        log(':+1: Code commited');

        return true;
      })
    })
  })
}

var rebuildNPM = function(arroProfileData){
  return inquirer.prompt([{
      type: 'confirm',
      name: 'rebuild',
      message: 'Do you want to rebuild the NPM modules?',
      default: false
    }
  ])
  .then(function(answers){
    if(!answers.rebuild){
      return Promise.resolve(true);
    }
    spinner = new Spinner("Installing NPM modules. Please wait...", ['⣾','⣽','⣻','⢿','⡿','⣟','⣯','⣷']);
    spinner.start();

    return exec("rm -rf node_modules;")
    .then(function(){
      return spawnP('docker run  -a stdout --rm -v '+process.cwd()+':/app -w /app ' + arroProfileData.test_image + ' npm install');
      return true;
    })
    .then(function(){
      spinner.stop();
      log(":+1: NPM modules finished installing.")
      return Promise.resolve(true);
    })
  });
}

var updateService = function(arroProfileData,sTag){
  log(":cyclone: Updating task definition " + arroProfileData.task);
  var definition = {
    "networkMode": "bridge",
    "family": arroProfileData.task,
    "volumes": [],
    "containerDefinitions": [{
      "environment": arroProfileData.env,
      "name" : arroProfileData.task,
      "image": arroProfileData.repo+":"+sTag,
      "memory": arroProfileData.container_memory,
      "cpu": arroProfileData.cpu_units,
      "mountPoints": [],
      "portMappings": [{
        "protocol": "tcp",
        "hostPort": arroProfileData.host_port,
        "containerPort": arroProfileData.app_port
      }],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options":{
          "awslogs-group" : arroProfileData.log,
          "awslogs-region" : AWS.config.region
        }
      },
      "essential": true,
      "volumesFrom": []
    }]
  }

  return new Promise(function(resolve,reject){
    var ecs= new AWS.ECS();
    ecs.registerTaskDefinition(definition,function(err,data){
      if(err)
        return reject(err);

      var params = {
        service: arroProfileData.service,
        taskDefinition: data.taskDefinition.taskDefinitionArn,
        cluster: arroProfileData.cluster
      }

      ecs.updateService(params,function(err,data){
        if(err)
          return reject(err);

        resolve(data);
      })
    })
  });
}

var getAWSAccountID = function(){
  return new Promise(function(resolve,reject){
    var sts = new AWS.STS();
    sts.getCallerIdentity({}, function(err, data) {
       if (err) {
          return reject(err);
       }
       return resolve(data.Account)
    });
  })
}

var buildImage = function(arroProfileData,tag){
  var sImage = arroProfileData.repo+":"+tag
  var sProfile = arroProfileData.profile;
  var sRepoName = arroProfileData.repo.split('amazonaws.com/')[1];
  var spinner;

  log(":closed_lock_with_key: Login into ECR")
  return exec('aws ecr get-login'+(sProfile?" --profile "+sProfile:""))
  .then(function(result){
    return exec(result);
  }).then(function(res){
    spinner = new Spinner("Building image '"+tag+"' from docker file '"+arroProfileData.dockerfile+"'", ['⣾','⣽','⣻','⢿','⡿','⣟','⣯','⣷']);
    spinner.start();

    return exec('docker build -f '+arroProfileData.dockerfile+' -t '+ sRepoName +' .')
  }).then(function(res){
    spinner.message("Tagging image '"+tag+"' from docker file '"+arroProfileData.dockerfile+"'")

    return exec('docker tag '+sRepoName+' '+sImage);
  }).then(function(res){
    spinner.message("Pushing image '"+tag+"' from docker file '"+arroProfileData.dockerfile+"'")

    return exec('docker push '+sImage);
  }).then(function(res){
    spinner.stop();
    log(":+1: Docker image pushed successfully.")
  })
}

var checkLogGroup = function(arroProfileData){
  return new Promise(function(resolve,reject){
    var cloudwatchlogs = new AWS.CloudWatchLogs();
    cloudwatchlogs.describeLogGroups({}, function(err, data) {
      if(err)
        return reject(err);

      var arroLogs = data.logGroups.filter(function(log){
        return arroProfileData.log == log.logGroupName;
      })

      if(!arroLogs.length){
        log(":cyclone: AWS log group not existant. Creating...")
        var params = {
          logGroupName: arroProfileData.log
        }
        cloudwatchlogs.createLogGroup(params, function(err, data) {
          if(err)
            return reject(err)

          log(":+1: AWS log group "+ arroProfileData.log + " successfully created");
          return resolve(true);
        });
      }else{
        log("AWS log group already created.")
        return resolve(true)
      }
    });
  })
}


var checkTag = function(arroProfileData,manual){
  return (manual?Promise.resolve(false):exec("git rev-parse --short HEAD").catch(function(err){
    return Promise.resolve(false);
  })).then(function(result){
    if(result){
      return result.trim();
    }

    return inquirer.prompt([{
      type: 'input',
      name: 'tag',
      message: 'Enter tag:',
      //[a-zA-Z0-9-_.]+
      validate: function(value) {
        var pass = value.match(/^([a-zA-Z0-9-_.]+)$/i)
        if(pass){
          return true;
        }

        return 'Invalid value, must validate "[a-zA-Z0-9-_.]+"';
      }
    }
    ]).then(function(answers){
      return answers.tag
    })

  }).then(function(tag){
    return new Promise(function(resolve,reject){
      var ecr = new AWS.ECR();
      var params = {
        repositoryName: arroProfileData.repo.split("amazonaws.com/")[1],
        imageIds: [
          {
            imageTag: tag
          }
        ]
      }

      ecr.describeImages(params, function(err, data) {
        if(err){
          if(err.code == "ImageNotFoundException")
            return resolve(tag);

          return reject(err);
        }

        log("Image tag "+tag+" already exists, please enter another:")
        return resolve(checkTag(arroProfileData,true));
      });
    })
  })
}

var addEnvVariables = function(arroProfileData){
  var envVariables = arroProfileData.env || [];

  var fRequest = function(){
    var table = new Table({
      head: ['#','Name', 'Value']
    });

    for(var i = 0; i < envVariables.length ; i++){
      table.push([i+1,envVariables[i].name,envVariables[i].value])
    }
    console.log(table.toString());

    return inquirer.prompt([{
      type: 'confirm',
      name: 'addenv',
      message: 'Do you want to add an ENV variable?',
      default: false
    }]).then(function(answers){
      if(!answers.addenv)
        return envVariables;

      return inquirer.prompt([
        {
          type: 'input',
          name: 'name',
          message: 'ENV variable name'
        },{
          type: 'input',
          name: 'value',
          message: 'ENV variable value'
        }
      ]).then(function(answers){
        envVariables.push({name:answers.name,value:answers.value});
        return fRequest();
      })
    })
  }

  return fRequest().then(function(){
    return {env:envVariables}
  })
}

var deploy = function(arroProfileData){
  log(':rocket: Deploying');

  var sAccount = false;
  var sTag = false;

  return fileExists(cwd+"/"+arroProfileData.dockerfile)
  .catch(function(){
    return Promise.reject(arroProfileData.dockerfile + " not found, please create it. Exiting.")
  })
  .then(function(){
    return checkTag(arroProfileData)
  })
  .then(function(tag){
    sTag = tag
    return checkLogGroup(arroProfileData);
  })
  .then(function(){
    return rebuildNPM(arroProfileData);
  })
  .then(function(){
    return buildImage(arroProfileData,sTag);
  })
  .then(function(){
    return updateService(arroProfileData,sTag);
  })
  .then(function(){
    log(":white_check_mark: Successfully deployed.")
  })
}

var events = function(arroProfileData){
  log(":fire: '"+arroProfileData.service.split("service/")[1]+"' service events");
  spinner = new Spinner("Retrieving events. Please wait...", ['⣾','⣽','⣻','⢿','⡿','⣟','⣯','⣷']);
  spinner.start();

  return new Promise(function(resolve,reject){
    var ecs = new AWS.ECS();

    var params = {
      services: [ /* required */
        arroProfileData.service
        /* more items */
      ],
      cluster: arroProfileData.cluster
    };
    ecs.describeServices(params, function(err, data) {
      if (err) return reject(err);

      var tableObj = new Table();

      for(let i = data.services[0].events.length-1; i >= 0 ;i--){
        var oEvent = data.services[0].events[i];
        tableObj.push([colors.red(timeAgo(new Date(oEvent.createdAt))),oEvent.message])
      }
      spinner.stop();
      console.log(tableObj.toString())
    });
  })
}

var getLogStreams = function(log){
  return new Promise(function(resolve,reject){
    var cloudwatchlogs = new AWS.CloudWatchLogs();

    var params = {
      logGroupName: log, /* required */
      descending: true,
      limit: 20,
      orderBy: "LastEventTime"
    };
    cloudwatchlogs.describeLogStreams(params, function(err, data) {
      if (err) return reject(err); // an error occurred

      resolve(data.logStreams.map(function(oStream){
        return oStream.logStreamName;
      }))
    });
  })
}

var fGetLogEvents = function(logName,streamName){
  return new Promise(function(resolve,reject){
    var cloudwatchlogs = new AWS.CloudWatchLogs();

    var params = {
      logGroupName: logName,
      logStreamName: streamName
    };
    cloudwatchlogs.getLogEvents(params, function(err, data) {
      if (err) return reject(err); // an error occurred

      var arroEvents = {};

      for(let i = 0 ; i < data.events.length;i++){
        var oEvent = data.events[i];

        if(!arroEvents[oEvent.timestamp])
          arroEvents[oEvent.timestamp] = [];

        arroEvents[oEvent.timestamp].push(oEvent.message)
      }
      resolve(arroEvents);           // successful response
    });
  })
}

var logs = function(arroProfileData){
  log(":fire: '"+arroProfileData.service.split("service/")[1]+"' service logs");
  spinner = new Spinner("Retrieving logs. Please wait...", ['⣾','⣽','⣻','⢿','⡿','⣟','⣯','⣷']);
  spinner.start();

  return getLogStreams(arroProfileData.log)
  .then(function(arrsStreams){
    arrsStreams.reverse();
    var arroPromises = [];
    for(let i = 0 ; i < arrsStreams.length;i++){
      arroPromises.push(fGetLogEvents(arroProfileData.log,arrsStreams[i]))
    }

    Promise.all(arroPromises)
    .then(function(arroData){

      var tableObj = new Table();

      for(let i = 0; i < arroData.length ;i++){
        tableObj.push([{colSpan:2,content:colors.green("Log stream")}])
        for(let key in arroData[i]){
          var arrsMessage = arroData[i][key];
          var oDate = new Date();
          oDate.setTime(key);
          tableObj.push([colors.red(timeAgo(oDate)),arrsMessage.join("\n")])
        }
      }

      spinner.stop();
      console.log(tableObj.toString())
    })
  })
}

var check = function(arroProfileData){
  log(":fire: Checking configuration settings");

  (function(){
    stdout("- Docker installation ")

    return commandExists('docker')
    .then(function(command){
      stdout(":heavy_check_mark: \n")
      return true;
    }).catch(function(){
      console.log("not found")
      return Promise.reject("Docker is not installed. Please go to https://docs.docker.com/engine/installation/")
    });
  })()
  .then(function(){
    stdout("- AWS profile ")
    return new Promise(function(resolve,reject){
      var creds = new AWS.SharedIniFileCredentials({profile: arroProfileData.profile});
      if(!creds.accessKeyId)
        return reject('Could not find profile "' + value + '"');

      AWS.config.update({region:'eu-west-1'});
      AWS.config.credentials = creds;

      stdout(":heavy_check_mark: \n")
      return resolve();
    })
  })
  .then(function(){
    stdout("- dockerfile exists ")
    return fileExists(cwd+"/"+arroProfileData.dockerfile).
    then(function(){
      stdout(":heavy_check_mark: \n")
    })
  })
  .then(function(){
    stdout("- repo exists ")

    return new Promise(function(resolve,reject){
      var ecr = new AWS.ECR();
      var sRepo = arroProfileData.repo.split("amazonaws.com/")[1]
      ecr.describeRepositories({repositoryNames:[sRepo]}, function(err, data) {
        if(err)
          return reject("Could not find repository '"+sRepo+"'")

        resolve(true)
      });
    })
    .then(function(){
      stdout(":heavy_check_mark: \n")
    })
  })
  .then(function(){
    stdout("- task definition exists ")

    return new Promise(function(resolve,reject){
      var ecs = new AWS.ECS();

      var params = {
          taskDefinition: arroProfileData.task
       };
       ecs.describeTaskDefinition(params, function(err, data) {
         if(err)
           return reject("Could not find task definition '"+arroProfileData.task+"'")

         resolve(true)
       });
    })
    .then(function(){
      stdout(":heavy_check_mark: \n")
    })
  })
  .then(function(){
    stdout("- cluster exists ")

    return new Promise(function(resolve,reject){
      var ecs = new AWS.ECS();

      var params = {
        clusters: [
          arroProfileData.cluster
        ]
       };

       ecs.describeClusters(params, function(err, data) {
         if(err || !data.clusters.length)
           return reject("Could not find cluster '"+arroProfileData.cluster.split("cluster/")[1]+"'")

         resolve(true)
       });
    })
    .then(function(){
      stdout(":heavy_check_mark: \n")
    })
  })
  .then(function(){
    stdout("- service exists ")

    return new Promise(function(resolve,reject){
      var ecs = new AWS.ECS();

      var params = {
        cluster: arroProfileData.cluster,
        services: [
          arroProfileData.task
        ]
       };

       ecs.describeServices(params, function(err, data) {
         if(err || !data.services.length)
           return reject("Could not find service '"+arroProfileData.task+"'")

         resolve(true)
       });
    })
    .then(function(){
      stdout(":heavy_check_mark: \n")
    })
  })
  .then(function(){
    log(":+1: All checks validated.")
  })
  .catch(function(err){
    log(':bangbang:  '+err);
    process.exit();
  })
}

var view = function(arroProfileData){
  var description = {
    env : "Environment variables",
    test_image: "Test image",
    local_port: "Local port",
    app_port: "App port",
    host_port: "Host port",
    cpu_units: "CPU units",
    container_memory: "Memory (MB)",
    log:"Cloudwatch log",
    service: "Service ARN",
    task: "Task name",
    cluster : "Cluster ARN",
    repo: "Repository URL",
    profile: "AWS Profile",
    dockerfile:"Docker file path"
  }


  var table = new Table({
    head: ['Name', 'Value']
  });

  for(var key in arroProfileData){
    if(key == "env"){
      var tableObj = new Table({
        head: ['#','Name', 'Value']
      });

      for(var i = 0; i < arroProfileData[key].length;i++){
        tableObj.push([i+1,arroProfileData[key][i].name,arroProfileData[key][i].value])
      }

      table.push([description[key] || key,tableObj.toString()])
    }else{
      table.push([description[key] || key,arroProfileData[key]])
    }
  }
  console.log(table.toString());
}

var configure = function(arroProfileData){
  return inquirer.prompt([{
      type: 'input',
      name: 'dockerfile',
      message: 'Enter DockerFile name:',
      default: arroProfileData.dockerfile || "Dockerfile",
      validate: function(value) {
        var done = this.async();

        fileExists(value).then(function(){
          done(null,true);
        }).catch(function(){
          done('Could not find DockerFile "' + value + '"');
        })

        return done;
      }
    },{
      type: 'input',
      name: 'profile',
      message: 'Enter AWS Profile you want to use:',
      default: arroProfileData.profile || "default",
      validate: function(value) {
        var done = this.async();
        var creds = new AWS.SharedIniFileCredentials({profile: value});
        if(creds.accessKeyId){
          AWS.config.update({region:'eu-west-1'});
          AWS.config.credentials = creds;
          return done(null,true);
        }else{
          log('\n:bangbang:  Could not find profile "' + value + '", please create a profile with "aws configure --profile '+value+'"');
          process.exit();
        }
        return done;
      }
    }
  ])
  .then(answers => {
    _.extend(arroProfileData,answers);

    var ecr = new AWS.ECR();
    log(":cyclone: Loading ECR repositories ...");
    return new Promise(function(resolve,reject){
      ecr.describeRepositories({maxResults:100}, function(err, data) {
        if(err){
          reject("Problem loading repositories");
        }
        resolve(data.repositories);
      });
    })
  })
  .then(repos => {
    return inquirer.prompt({
      type: 'list',
      name: 'repo',
      message: 'Select repository:',
      default: arroProfileData.repo || null,
      choices: repos.map(function(repo){ return {name:repo.repositoryName, value:repo.repositoryUri} }).sort(compare),
    })
  })
  .then(answers => {
    _.extend(arroProfileData,answers);

    var ecs = new AWS.ECS();
    log(":cyclone: Loading ECS clusters ...");
    return new Promise(function(resolve,reject){
      ecs.listClusters({maxResults:100}, function(err, data) {
        if(err){
          reject("Problem loading clusters");
        }
        resolve(data.clusterArns);
      });
    })
  })
  .then(clusters => {
    return inquirer.prompt({
      type: 'list',
      name: 'cluster',
      message: 'Select cluster:',
      default: arroProfileData.cluster || null,
      choices: clusters.map(function(cluster){ return {name:cluster.split("cluster/")[1], value:cluster} }).sort(compare),
    })
  })
  .then(answers => {
    _.extend(arroProfileData,answers);

    var ecs = new AWS.ECS();
    log(":cyclone: Loading ECS task definitions ...");
    return new Promise(function(resolve,reject){
      ecs.listTaskDefinitionFamilies({maxResults:100}, function(err, data) {
        if(err){
          reject("Problem loading task definitions");
        }
        resolve(data.families);
      });
    })
  }).then(tasks => {
    return inquirer.prompt({
      type: 'list',
      name: 'task',
      message: 'Select task definition:',
      default: arroProfileData.task || null,
      choices: tasks.map(function(task){ return {name:task, value:task} }).sort(compare),
    })
  })
  .then(answers => {
    _.extend(arroProfileData,answers);

    var ecs = new AWS.ECS();
    log(":cyclone: Loading ECS services ...");
    return new Promise(function(resolve,reject){
      ecs.listServices({maxResults:100,cluster:arroProfileData.cluster}, function(err, data) {
        if(err){
          reject("Problem loading services");
        }
        resolve(data.serviceArns);
      });
    })
  })
  .then(tasks => {
    return inquirer.prompt({
      type: 'list',
      name: 'service',
      message: 'Select service:',
      default: arroProfileData.service || null,
      choices: tasks.map(function(service){ return {name:service.split("service/")[1], value:service} }).sort(compare),
    })
  })
  .then(answers => {
    _.extend(arroProfileData,answers);

    return inquirer.prompt({
      type: 'input',
      default: arroProfileData.log || (arroProfileData.task),
      name: 'log',
      message: 'Log group name:'
    })
  })
  .then(answers => {
    _.extend(arroProfileData,answers);

    log("Container configuration:");

    return inquirer.prompt([{
      type: 'input',
      default: arroProfileData.container_memory || 128,
      name: 'container_memory',
      message: 'Container memory:',
      filter: Number
    },{
      type: 'input',
      default: arroProfileData.cpu_units || 0,
      name: 'cpu_units',
      message: 'CPU units:',
      filter: Number
    },{
      type: 'input',
      default: arroProfileData.host_port || 0,
      name: 'host_port',
      message: 'Host port (0 is dynamic port attribution):',
      filter: Number
    },{
      type: 'input',
      default: arroProfileData.app_port || 8080,
      name: 'app_port',
      message: 'App port:',
      filter: Number
    },{
      type: 'input',
      default: arroProfileData.local_port || 8080,
      name: 'local_port',
      message: 'Local port for testing:',
      filter: Number
    },{
      type: 'input',
      default: arroProfileData.test_image || "node:6.10.1",
      name: 'test_image',
      message: 'Container image for local testing:'
    }])
  })
  .then(answers => {
    _.extend(arroProfileData,answers);

    return addEnvVariables(arroProfileData);
  })
  .then(answers => {
    _.extend(arroProfileData,answers);

    return new Promise(function(resolve,reject){
      fs.writeFile(sFileName, JSON.stringify(arroProfileData), function (err) {
        if(err)
          return reject("Could not save configuration file.")

        resolve(true)
      });
    })
  })
  .then(result => {
    log(":white_check_mark: Configuration file saved.")
  })
  .catch(function(err){
    log(':bangbang:  '+err);
    process.exit();
  })
}

var loadAWSProfile = function(arroProfileData){
  return new Promise(function(resolve,reject){
    var creds = new AWS.SharedIniFileCredentials({profile: arroProfileData.profile});
    if(!creds.accessKeyId)
      return reject('Could not find profile "' + value + '"');

    AWS.config.update({region:'eu-west-1'});
    AWS.config.credentials = creds;

    return resolve(arroProfileData);
  })
}

var logError=function(err){
  log(':bangbang:  '+err);
  process.exit();
}

var loadConfigFile = function(sFileName){
  return loadFile(cwd+"/"+sFileName)
  .catch(function(){
    return Promise.reject('Could not load the configuration file: '+sFileName);
  })
}


//Start arguments
let argv = yargs
  .usage('$0 <cmd> [args]')
  .option('profile', {
      alias: 'p',
      describe: "Profile to work on.",
      demandOption: false,
      default:"",
      type: 'string'
  })

  .option('c', {
      describe: "Commit code.",
      demandOption: false
  })
  .option('d', {
      describe: "Deploy container.",
      demandOption: false
  })
  .command('deploy','Deploy the code into ECR & ECS (will use the GIT short hash as version if available)')
  .command('run','Run local container.')
  .command('info','View a configuration table.')
  .command('events','View service events.')
  .command('logs','View service logs.')
  .command('check','Check configuration.')
  .command('configure','Change a config file configuration.')
  .command('init','Initialise a config file.')
  .help()
  .argv

var sProfile = argv.profile || "";
var sFileName = "ECSConfig"+(sProfile?"_"+sProfile:"")+".json";

if(argv._.indexOf("configure") !== -1){
  loadConfigFile(sFileName)
  .then(configure)
  .catch(logError)
}else if(argv._.indexOf("deploy") !== -1){
  loadConfigFile(sFileName)
  .then(loadAWSProfile)
  .then(deploy)
  .catch(logError)
}else if(argv._.indexOf("commit") !== -1){
  loadConfigFile(sFileName)
  .then(loadAWSProfile)
  .then(commit)
  .catch(logError)
}else if(argv._.indexOf("check") !== -1){
  loadConfigFile(sFileName)
  .then(check)
  .catch(logError)
}else if(argv._.indexOf("events") !== -1){
  loadConfigFile(sFileName)
  .then(loadAWSProfile)
  .then(events)
  .catch(logError)
}else if(argv._.indexOf("logs") !== -1){
  loadConfigFile(sFileName)
  .then(loadAWSProfile)
  .then(logs)
  .catch(logError)
}else if(argv._.indexOf("info") !== -1){
  loadConfigFile(sFileName)
  .then(view)
  .catch(logError)
}else if(argv._.indexOf("init") !== -1){
  fileExists(sFileName)
  .then(function(){
    logError("Configuration file "+sFileName+" already exists, please use --configure to edit it.");
  })
  .catch(function(){
    configure({});
  })
}else if(argv._.indexOf("run") !== -1){
  var oProfile;
  loadConfigFile(sFileName)
  .then(function(arroProfileData){
    oProfile = arroProfileData;
    return exec("docker-machine ip")
  }).then(function(ip){
    log(":arrow_forward:  Running local container on http://"+ip.trim()+":"+oProfile.local_port+" with docker image '"+oProfile.test_image+"'");
    child_process.spawnSync("docker",("run --rm --name "+oProfile.task+" --publish "+oProfile.local_port+":"+oProfile.app_port+" -ti -w /app -v "+process.cwd()+":/app "+oProfile.test_image+" bash").split(" "),{stdio:"inherit"})
  }).catch(function(err){
    log(':bangbang:  '+err);
    process.exit();
  })
}else{

  var bValidCommand = false;
  loadConfigFile(sFileName)
  .then(loadAWSProfile)
  .then(function(arroProfileData){
    if(argv.c){
      bValidCommand = true;
      return commit(arroProfileData);
    }

    return arroProfileData;
  })
  .then(function(arroProfileData){
    if(argv.d){
      bValidCommand = true;
      return deploy(arroProfileData);
    }

    return arroProfileData;
  })
  .then(function(){
    if(!bValidCommand){
      yargs.showHelp()
    }
  })
  .catch(logError)
}
