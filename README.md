# ecs-aws
Deploy easily docker containers into AWS ECS

## disclaimer

This script was made to simplify the deployement process and is used internally on production level but is not exempted of bugs.
Use at your own risk and I cannot be held responsible for any errors that might occur.

## installation

`npm install -g ecs-aws`

## dependencies

This CLI uses the AWS CLI key/secretKey to do the requests. Please set that up before.

AWS CLI min 1.11.167: https://aws.amazon.com/cli

docker & docker-machine: https://docs.docker.com/engine/installation/

## usage

ecs-aws allows you to deploy an ECS service without having to modify all the configuration and task definition over and over.

**This script is an alpha version and does not allow the creation of services directly. Set that up in your ECR environment or the AWS Console first**

**The task definition and container name have to be the same. This will be changed in later versions.**

**A docker file needs to be in the directory. It will be requested during the init and you can have multiple ones in the same directory for different services (ex: scheduled services)**

initialise a directory where you want have a Dockerfile and code using `ecs-aws init --profile [profilename]`. You will be requested an AWS cli profile (you can setup one by doing `aws configure --profile [profilename]`) in order to retrieve the different services and clusters.

after initialisation you can:

* run `ecs-aws run [--profile profilename]` to run the container locally
* run `ecs-aws configure [--profile profilename]` to change configuration
* run `ecs-aws view [--profile profilename]` to view the configuration variables

Other parameters:
* `--help`: help
* `-c`: commit your code changes
* `-d`: deploy the code into ECR (will use the GIT short hash as version if available)


## TO-DO

* Being able to setup scheduled containers
