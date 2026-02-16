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

## IAM Permissions

This tool automatically checks for required AWS IAM permissions before performing create or delete operations. If you lack necessary permissions, the tool will display exactly which permissions are missing.

### Creating Services

Required permissions:

- `ecs:CreateService`
- `ecs:RegisterTaskDefinition`
- `ecs:DescribeServices`
- `ecr:CreateRepository`
- `ecr:GetAuthorizationToken`
- `ecr:InitiateLayerUpload`
- `ecr:UploadLayerPart`
- `ecr:CompleteLayerUpload`
- `ecr:PutImage`
- `logs:CreateLogGroup`
- `elasticloadbalancing:CreateTargetGroup`
- `elasticloadbalancing:CreateRule`
- `route53:ChangeResourceRecordSets` (if using custom domains)

### Deleting Services

Required permissions:

- `ecs:DeleteService`
- `ecs:UpdateService`
- `ecs:DeregisterTaskDefinition`
- `ecr:DeleteRepository`
- `logs:DeleteLogGroup`
- `elasticloadbalancing:DeleteTargetGroup`
- `elasticloadbalancing:DeleteRule`
- `route53:ChangeResourceRecordSets` (if using custom domains)

Contact your AWS administrator if you need these permissions added to your IAM user or role.

## usage

ecs-aws allows you to deploy an ECS service without having to modify all the configuration and task definition over and over.

**This script is not meant to be for creating services directly. Set that up in your ECR environment or the AWS Console first**

**The task definition and container name have to be the same. This will be changed in later versions.**

**A docker file needs to be in the directory. It will be requested during the init and you can have multiple ones in the same directory for different services (ex: scheduled services)**

Initialise a directory where you have a Dockerfile and code using `ecs-aws init [--profile profilename]`. You will be requested an AWS cli profile (you can setup one by doing `aws configure [--profile profilename]`) in order to retrieve the different services and clusters. The script will create `ECSConfig[profilename].json` in the directory after setup.

after initialisation you can:

#### configuration

- `ecs-aws configure [--profile profilename]` to change configuration
- `ecs-aws check [--profile profilename]` to check the configuration
- `ecs-aws info [--profile profilename]` to view the configuration

#### deployment

- `ecs-aws deploy [--profile profilename]` to deploy the code into ECR & ECS (The GIT short hash will be used as version if available)

#### service commit

- `ecs-aws commit [--profile profilename]` commit your code changes

**This command is available if the directory is a GIT repository**

#### service info

- `ecs-aws logs [--profile profilename]` to view the service's logs
  - Add `--browser` or `-b` flag to open CloudWatch logs in your browser
  - Example: `ecs-aws logs -b -p` (will prompt for profile selection)
- `ecs-aws tail [--profile profilename]` to tail service logs in real-time
  - Add `--browser` or `-b` flag to open CloudWatch Live Tail in your browser
  - Example: `ecs-aws tail -b -p production`
- `ecs-aws events [--profile profilename]` to view the service's events
- `ecs-aws dash [--profile profilename]` to view the dashboard [BETA]

#### service management

- `ecs-aws delete-service [--profile profilename]` to delete an ECS service and all associated resources
  - Automatically checks for required permissions before deletion
  - This will delete: ECS service, task definition, target group, listener rules, CloudWatch log group, ECR repository, and optionally Route53 DNS records
  - If permissions are missing, the tool will show exactly which ones are needed

**Note:** When creating a new service during `init` configuration, the tool will check if you have the necessary IAM permissions and display any missing permissions.

#### local testing

- `ecs-aws run [--profile profilename]` to run the container locally
- `ecs-aws rebuild [--profile profilename]` to rebuild the container image

#### Other parameters:

- `--help`: help
- `-c`: alias to `ecs-aws commit`
- `-d`: alias to `ecs-aws deploy`

## Run your container locally

The old ecs-aws versions used to generate an image everytime `ecs-aws run` was launched and removed it afterwards. This is no longer the case; ecs-aws will create a container image from the `Dockerfile` setup in the configuration profile and keep it after the script has stopped.

This allows for a faster and more reliable testing with a full usage of the Dockerfile.

If the Dockerfile has been modified run `ecs-aws rebuild [--profile profilename]` to rebuild the docker image to the latest version.

**The local testing will use the maximum memory set in the configuration profile file**

## Dashboard

A beta version of the dashboard is available by calling `ecs-aws dash [--profile profilename]`

You can copy the `ECSConfig.json` file and run ecs-aws to see the monitoring if you wish to setup a screen,

## TO-DO

- Being able to setup scheduled containers
