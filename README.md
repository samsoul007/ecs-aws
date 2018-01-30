# ecs-aws [![npm version](https://badge.fury.io/js/ecs-aws.svg)](https://badge.fury.io/js/ecs-aws)


Deploy easily docker containers into AWS ECS

## disclaimer

This script was made to simplify the deployement process and is used internally on production level but is not exempted of bugs.
Use at your own risk and I cannot be held responsible for any errors that might occur.

This software was built to allow developers to deploy and check their respective containers/services. You need to have an AWS account to be able to use this.
With the right IAM permissions, the AWS admin can control who has access to what and specific team members can deploy and monitor without ever touching the baseline configuration.

**No access or secret keys are stored by this script.**

## installation

`npm install -g ecs-aws`

## dependencies

This CLI uses the AWS CLI key/secretKey to do the requests. Please set that up before.

AWS CLI min 1.11.167: https://aws.amazon.com/cli

docker & docker-machine: https://docs.docker.com/engine/installation/

## usage

ecs-aws allows you to deploy an ECS service without having to modify all the configuration and task definition over and over.

**This script is not meant to be for creating services directly. Set that up in your ECR environment or the AWS Console first**

**The task definition and container name have to be the same. This will be changed in later versions.**

**A docker file needs to be in the directory. It will be requested during the init and you can have multiple ones in the same directory for different services (ex: scheduled services)**

initialise a directory where you want have a Dockerfile and code using `ecs-aws init --profile [profilename]`. You will be requested an AWS cli profile (you can setup one by doing `aws configure --profile [profilename]`) in order to retrieve the different services and clusters.

after initialisation you can:
* `ecs-aws configure [--profile profilename]` to change configuration
* `ecs-aws deploy [--profile profilename]` to deploy the code into ECR & ECS (will use the GIT short hash as version if available)
* `ecs-aws run [--profile profilename]` to run the container locally
* `ecs-aws commit [--profile profilename]` commit your code changes
* `ecs-aws check [--profile profilename]` to check the configuration
* `ecs-aws info [--profile profilename]` to view the configuration
* `ecs-aws logs [--profile profilename]` to view the service's logs
* `ecs-aws events [--profile profilename]` to view the service's events
* `ecs-aws dash [--profile profilename]` to view the dashboard [BETA]


Other parameters:
* `--help`: help
* `-c`: alias to `ecs-aws commit`
* `-d`: alias to `ecs-aws deploy`

## dashboard

A beta version of the dashboard is available by calling `ecs-aws dash [--profile profilename]`

You can copy the `ECSConfig.json` file and run ecs-aws to see the monitoring if you wish to setup a screen,


## TO-DO

* Being able to setup scheduled containers
