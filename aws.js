const { ECSClient, DescribeServicesCommand, RegisterTaskDefinitionCommand, UpdateServiceCommand, DescribeTaskDefinitionCommand, DescribeClustersCommand, ListClustersCommand, ListTaskDefinitionFamiliesCommand, ListServicesCommand, CreateServiceCommand, DeleteServiceCommand, DeregisterTaskDefinitionCommand, WaiterState, waitUntilServicesStable } = require('@aws-sdk/client-ecs');
const { CloudWatchLogsClient, DescribeLogStreamsCommand, GetLogEventsCommand, DescribeLogGroupsCommand, CreateLogGroupCommand, DeleteLogGroupCommand } = require('@aws-sdk/client-cloudwatch-logs');
const { CloudWatchClient, GetMetricStatisticsCommand } = require('@aws-sdk/client-cloudwatch');
const { ECRClient, DescribeImagesCommand, DescribeRepositoriesCommand, CreateRepositoryCommand, DeleteRepositoryCommand } = require('@aws-sdk/client-ecr');
const { EC2Client, DescribeRegionsCommand } = require('@aws-sdk/client-ec2');
const { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand, DescribeTargetGroupsCommand, DescribeListenersCommand, CreateTargetGroupCommand, CreateRuleCommand, DescribeRulesCommand, DeleteTargetGroupCommand, DeleteRuleCommand } = require('@aws-sdk/client-elastic-load-balancing-v2');
const { Route53Client, ListHostedZonesCommand, ChangeResourceRecordSetsCommand } = require('@aws-sdk/client-route-53');
const { IAMClient, SimulatePrincipalPolicyCommand } = require('@aws-sdk/client-iam');
const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
const { fromIni } = require('@aws-sdk/credential-providers');
const fs = require('fs');
const os = require('os');
const path = require('path');

let ecsClient = new ECSClient({});
let cloudwatchlogsClient = new CloudWatchLogsClient({});
let cloudwatchClient = new CloudWatchClient({});
let ecrClient = new ECRClient({});
let ec2Client = new EC2Client({});
let elbv2Client = new ElasticLoadBalancingV2Client({});
let route53Client = new Route53Client({});
let iamClient = new IAMClient({});
let stsClient = new STSClient({});

const getServiceData = async (arroProfileData) => {
  const params = {
    services: [ /* required */
      arroProfileData.service,
      /* more items */
    ],
    cluster: arroProfileData.cluster,
  };
  const command = new DescribeServicesCommand(params);
  return ecsClient.send(command);
};

const getLogStreams = async (sLogName) => {
  const params = {
    logGroupName: sLogName,
    /* required */
    descending: true,
    limit: 2,
    orderBy: 'LastEventTime',
  };

  const command = new DescribeLogStreamsCommand(params);
  const data = await cloudwatchlogsClient.send(command);
  return data.logStreams.map(oStream => oStream.logStreamName);
};

const getLogEvents = async (logName, streamName, startime) => {
  const params = {
    logGroupName: logName,
    logStreamName: streamName,
  };

  if (startime) {
    params.startTime = startime;
  }

  const command = new GetLogEventsCommand(params);
  const data = await cloudwatchlogsClient.send(command);

  const arroEvents = {};

  for (let i = 0; i < data.events.length; i += 1) {
    const oEvent = data.events[i];

    if (!arroEvents[oEvent.timestamp]) arroEvents[oEvent.timestamp] = [];

    arroEvents[oEvent.timestamp].push(oEvent.message);
  }
  return arroEvents; // successful response
};

const loadAWSProfiles = () => {
  const profiles = [];
  const homeDir = os.homedir();
  const credentialsPath = path.join(homeDir, '.aws', 'credentials');
  const configPath = path.join(homeDir, '.aws', 'config');

  // Helper function to parse profiles from file content
  const parseProfiles = (content, isConfigFile = false) => {
    const lines = content.split('\n');
    const profileRegex = isConfigFile ? /^\[profile\s+(.+)\]$/ : /^\[(.+)\]$/;

    lines.forEach(line => {
      const match = line.trim().match(profileRegex);
      if (match) {
        const profileName = match[1].trim();
        if (!profiles.includes(profileName)) {
          profiles.push(profileName);
        }
      }
    });
  };

  // Read credentials file
  try {
    if (fs.existsSync(credentialsPath)) {
      const credentialsContent = fs.readFileSync(credentialsPath, 'utf8');
      parseProfiles(credentialsContent, false);
    }
  } catch (error) {
    // Ignore errors, file might not exist
  }

  // Read config file
  try {
    if (fs.existsSync(configPath)) {
      const configContent = fs.readFileSync(configPath, 'utf8');
      parseProfiles(configContent, true);
    }
  } catch (error) {
    // Ignore errors, file might not exist
  }

  // Ensure 'default' is included if it exists
  if (!profiles.includes('default') && profiles.length > 0) {
    // Check if default profile actually exists
    try {
      if (fs.existsSync(credentialsPath)) {
        const credentialsContent = fs.readFileSync(credentialsPath, 'utf8');
        if (credentialsContent.includes('[default]')) {
          profiles.unshift('default');
        }
      }
    } catch (error) {
      // Ignore
    }
  }

  return profiles;
};

const loadAWSProfile = async (arroProfileData) => {
  try {
    const credentials = fromIni({
      profile: arroProfileData.profile,
    });

    const region = arroProfileData.region || 'eu-west-1';

    // Recreate clients with proper credentials and region
    ecsClient = new ECSClient({ region, credentials });
    cloudwatchlogsClient = new CloudWatchLogsClient({ region, credentials });
    cloudwatchClient = new CloudWatchClient({ region, credentials });
    ecrClient = new ECRClient({ region, credentials });
    ec2Client = new EC2Client({ region, credentials });
    elbv2Client = new ElasticLoadBalancingV2Client({ region, credentials });
    route53Client = new Route53Client({ region, credentials });
    iamClient = new IAMClient({ region, credentials });
    stsClient = new STSClient({ region, credentials });

    // Test credentials by attempting to get caller identity
    await credentials();

    return arroProfileData;
  } catch (error) {
    throw new Error(`Could not find profile "${arroProfileData.profile}"`);
  }
};

const updateService = async (arroProfileData, sTag, region) => {
  if (!arroProfileData.task) {
    return true;
  }

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
          'awslogs-region': region || arroProfileData.region || 'eu-west-1',
        },
      },
      linuxParameters: {
        sharedMemorySize: arroProfileData.container_memory
      },
      essential: true,
      volumesFrom: []
    }],
  };

  const registerCommand = new RegisterTaskDefinitionCommand(definition);
  const data = await ecsClient.send(registerCommand);

  const params = {
    service: arroProfileData.service,
    taskDefinition: data.taskDefinition.taskDefinitionArn,
    cluster: arroProfileData.cluster,
  };

  const updateCommand = new UpdateServiceCommand(params);
  return ecsClient.send(updateCommand);
};

const checkTag = async (arroProfileData, tag) => {
  const params = {
    repositoryName: arroProfileData.repo.split('amazonaws.com/')[1],
    imageIds: [{
      imageTag: tag,
    }],
  };

  const command = new DescribeImagesCommand(params);

  try {
    await ecrClient.send(command);
    return { exists: true };
  } catch (err) {
    if (err.name === 'ImageNotFoundException') {
      return { exists: false, tag };
    }
    throw err;
  }
};

const checkLogGroup = async (arroProfileData) => {
  const describeCommand = new DescribeLogGroupsCommand({});
  const data = await cloudwatchlogsClient.send(describeCommand);

  const arroLogs = data.logGroups.filter(oLog => arroProfileData.log === oLog.logGroupName);

  if (!arroLogs.length) {
    const params = {
      logGroupName: arroProfileData.log,
    };
    const createCommand = new CreateLogGroupCommand(params);
    await cloudwatchlogsClient.send(createCommand);
    return { created: true };
  }
  return { created: false };
};

const checkDockerRepo = async (repoName) => {
  const command = new DescribeRepositoriesCommand({
    repositoryNames: [repoName],
  });
  return ecrClient.send(command);
};

const checkTaskDefinition = async (taskName) => {
  const params = {
    taskDefinition: taskName,
  };
  const command = new DescribeTaskDefinitionCommand(params);
  return ecsClient.send(command);
};

const checkCluster = async (clusterArn) => {
  const params = {
    clusters: [clusterArn],
  };
  const command = new DescribeClustersCommand(params);
  return ecsClient.send(command);
};

const checkService = async (cluster, taskName) => {
  const params = {
    cluster: cluster,
    services: [taskName],
  };
  const command = new DescribeServicesCommand(params);
  return ecsClient.send(command);
};

const loadRegions = async () => {
  const command = new DescribeRegionsCommand({});
  const data = await ec2Client.send(command);

  if (!data.Regions || !data.Regions.length) {
    throw new Error('No regions found');
  }

  return data.Regions;
};

const loadRepositories = async () => {
  const command = new DescribeRepositoriesCommand({
    maxResults: 100,
  });
  const data = await ecrClient.send(command);

  if (!data.repositories || !data.repositories.length) {
    throw new Error('No repositories found');
  }

  return data.repositories;
};

const loadClusters = async () => {
  const command = new ListClustersCommand({
    maxResults: 100,
  });
  const data = await ecsClient.send(command);

  if (!data.clusterArns || !data.clusterArns.length) {
    throw new Error('No clusters found');
  }

  return data.clusterArns;
};

const loadTaskDefinitions = async () => {
  const command = new ListTaskDefinitionFamiliesCommand({
    maxResults: 100,
  });
  const data = await ecsClient.send(command);
  return data.families;
};

const loadServices = async (cluster) => {
  const command = new ListServicesCommand({
    maxResults: 100,
    cluster: cluster,
  });
  const data = await ecsClient.send(command);
  return data.serviceArns;
};

const getMetricStatistics = async (params) => {
  const command = new GetMetricStatisticsCommand(params);
  const data = await cloudwatchClient.send(command);
  return data.Datapoints
    .map((dp) => {
      const dataPoint = dp;
      dataPoint.Timestamp = new Date(dataPoint.Timestamp);
      return dataPoint;
    })
    .sort((a, b) => a.Timestamp - b.Timestamp);
};

// New service creation functions
const createECRRepository = async (repositoryName) => {
  const command = new CreateRepositoryCommand({
    repositoryName: repositoryName,
  });
  const data = await ecrClient.send(command);
  return data.repository;
};

const createTaskDefinitionForNewService = async (params) => {
  const command = new RegisterTaskDefinitionCommand(params);
  const data = await ecsClient.send(command);
  return data.taskDefinition;
};

const loadLoadBalancers = async () => {
  const command = new DescribeLoadBalancersCommand({});
  const data = await elbv2Client.send(command);
  return data.LoadBalancers || [];
};

const loadTargetGroups = async (loadBalancerArn) => {
  const command = new DescribeTargetGroupsCommand({
    LoadBalancerArn: loadBalancerArn,
  });
  const data = await elbv2Client.send(command);
  return data.TargetGroups || [];
};

const loadListeners = async (loadBalancerArn) => {
  const command = new DescribeListenersCommand({
    LoadBalancerArn: loadBalancerArn,
  });
  const data = await elbv2Client.send(command);
  return data.Listeners || [];
};

const createTargetGroup = async (params) => {
  const command = new CreateTargetGroupCommand(params);
  const data = await elbv2Client.send(command);
  return data.TargetGroups[0];
};

const createListenerRule = async (params) => {
  const command = new CreateRuleCommand(params);
  const data = await elbv2Client.send(command);
  return data.Rules[0];
};

const loadListenerRules = async (listenerArn) => {
  const command = new DescribeRulesCommand({
    ListenerArn: listenerArn,
  });
  const data = await elbv2Client.send(command);
  return data.Rules || [];
};

const createECSService = async (params) => {
  const command = new CreateServiceCommand(params);
  const data = await ecsClient.send(command);
  return data.service;
};

const waitForServiceRunning = async (cluster, serviceName) => {
  try {
    const result = await waitUntilServicesStable(
      {
        client: ecsClient,
        maxWaitTime: 300, // 5 minutes
      },
      {
        cluster: cluster,
        services: [serviceName],
      }
    );
    return result.state === WaiterState.SUCCESS;
  } catch (error) {
    return false;
  }
};

// Rollback/Deletion functions
const deleteECRRepository = async (repositoryName) => {
  try {
    const command = new DeleteRepositoryCommand({
      repositoryName: repositoryName,
      force: true, // Delete even if it contains images
    });
    await ecrClient.send(command);
    return true;
  } catch (error) {
    console.error(`Failed to delete ECR repository ${repositoryName}:`, error.message);
    return false;
  }
};

const deleteCloudWatchLogGroup = async (logGroupName) => {
  try {
    const command = new DeleteLogGroupCommand({
      logGroupName: logGroupName,
    });
    await cloudwatchlogsClient.send(command);
    return true;
  } catch (error) {
    console.error(`Failed to delete log group ${logGroupName}:`, error.message);
    return false;
  }
};

const deregisterTaskDefinition = async (taskDefinitionArn) => {
  try {
    const command = new DeregisterTaskDefinitionCommand({
      taskDefinition: taskDefinitionArn,
    });
    await ecsClient.send(command);
    return true;
  } catch (error) {
    console.error(`Failed to deregister task definition ${taskDefinitionArn}:`, error.message);
    return false;
  }
};

const deleteTargetGroup = async (targetGroupArn) => {
  try {
    const command = new DeleteTargetGroupCommand({
      TargetGroupArn: targetGroupArn,
    });
    await elbv2Client.send(command);
    return true;
  } catch (error) {
    console.error(`Failed to delete target group ${targetGroupArn}:`, error.message);
    return false;
  }
};

const deleteListenerRule = async (ruleArn) => {
  try {
    const command = new DeleteRuleCommand({
      RuleArn: ruleArn,
    });
    await elbv2Client.send(command);
    return true;
  } catch (error) {
    console.error(`Failed to delete listener rule ${ruleArn}:`, error.message);
    return false;
  }
};

const deleteECSService = async (cluster, serviceName) => {
  try {
    // First, scale service to 0
    const updateCommand = new UpdateServiceCommand({
      cluster: cluster,
      service: serviceName,
      desiredCount: 0,
    });
    await ecsClient.send(updateCommand);

    // Wait a bit for tasks to stop
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Delete the service
    const deleteCommand = new DeleteServiceCommand({
      cluster: cluster,
      service: serviceName,
      force: true,
    });
    await ecsClient.send(deleteCommand);
    return true;
  } catch (error) {
    console.error(`Failed to delete ECS service ${serviceName}:`, error.message);
    return false;
  }
};

// Route53 functions
const listHostedZones = async () => {
  try {
    const command = new ListHostedZonesCommand({});
    const data = await route53Client.send(command);
    return data.HostedZones || [];
  } catch (error) {
    console.error('Failed to list hosted zones:', error.message);
    return [];
  }
};

const findHostedZoneForDomain = async (hostname) => {
  const zones = await listHostedZones();

  // Extract domain from hostname (e.g., api.example.com -> example.com)
  const parts = hostname.split('.');

  // Try to match from most specific to least specific
  for (let i = 0; i < parts.length - 1; i++) {
    const domain = parts.slice(i).join('.');
    const normalizedDomain = domain.endsWith('.') ? domain : domain + '.';

    const zone = zones.find(z => z.Name === normalizedDomain);
    if (zone) {
      return zone;
    }
  }

  return null;
};

const createRoute53Record = async (hostname, loadBalancerDNSName, loadBalancerHostedZoneId) => {
  try {
    const hostedZone = await findHostedZoneForDomain(hostname);

    if (!hostedZone) {
      throw new Error(`No Route53 hosted zone found for domain: ${hostname}`);
    }

    const normalizedHostname = hostname.endsWith('.') ? hostname : hostname + '.';

    const command = new ChangeResourceRecordSetsCommand({
      HostedZoneId: hostedZone.Id,
      ChangeBatch: {
        Changes: [{
          Action: 'UPSERT',
          ResourceRecordSet: {
            Name: normalizedHostname,
            Type: 'A',
            AliasTarget: {
              HostedZoneId: loadBalancerHostedZoneId,
              DNSName: loadBalancerDNSName,
              EvaluateTargetHealth: true,
            },
          },
        }],
      },
    });

    const data = await route53Client.send(command);
    return {
      success: true,
      changeId: data.ChangeInfo.Id,
      hostedZone: hostedZone.Name,
    };
  } catch (error) {
    console.error(`Failed to create Route53 record for ${hostname}:`, error.message);
    return {
      success: false,
      error: error.message,
    };
  }
};

const deleteRoute53Record = async (hostname, loadBalancerDNSName, loadBalancerHostedZoneId) => {
  try {
    const hostedZone = await findHostedZoneForDomain(hostname);

    if (!hostedZone) {
      console.log(`No Route53 hosted zone found for domain: ${hostname}`);
      return false;
    }

    const normalizedHostname = hostname.endsWith('.') ? hostname : hostname + '.';

    const command = new ChangeResourceRecordSetsCommand({
      HostedZoneId: hostedZone.Id,
      ChangeBatch: {
        Changes: [{
          Action: 'DELETE',
          ResourceRecordSet: {
            Name: normalizedHostname,
            Type: 'A',
            AliasTarget: {
              HostedZoneId: loadBalancerHostedZoneId,
              DNSName: loadBalancerDNSName,
              EvaluateTargetHealth: true,
            },
          },
        }],
      },
    });

    await route53Client.send(command);
    return true;
  } catch (error) {
    console.error(`Failed to delete Route53 record for ${hostname}:`, error.message);
    return false;
  }
};

// Get AWS Account ID
const getAccountId = async () => {
  try {
    const identityCommand = new GetCallerIdentityCommand({});
    const identity = await stsClient.send(identityCommand);
    return identity.Account;
  } catch (error) {
    throw new Error(`Failed to get AWS account ID: ${error.message}`);
  }
};

// IAM permission checking for create operations
const checkCreatePermissions = async () => {
  try {
    // Get current user ARN
    const identityCommand = new GetCallerIdentityCommand({});
    const identity = await stsClient.send(identityCommand);

    const requiredActions = [
      'ecs:CreateService',
      'ecs:RegisterTaskDefinition',
      'ecs:DescribeServices',
      'ecr:CreateRepository',
      'ecr:GetAuthorizationToken',
      'ecr:InitiateLayerUpload',
      'ecr:UploadLayerPart',
      'ecr:CompleteLayerUpload',
      'ecr:PutImage',
      'logs:CreateLogGroup',
      'elasticloadbalancing:CreateTargetGroup',
      'elasticloadbalancing:CreateRule',
    ];

    const simulateCommand = new SimulatePrincipalPolicyCommand({
      PolicySourceArn: identity.Arn,
      ActionNames: requiredActions,
    });

    const result = await iamClient.send(simulateCommand);

    const deniedActions = result.EvaluationResults
      .filter(r => r.EvalDecision !== 'allowed')
      .map(r => r.EvalActionName);

    return {
      allowed: deniedActions.length === 0,
      deniedActions: deniedActions,
      userArn: identity.Arn,
    };
  } catch (error) {
    // If we can't check permissions, assume they have them
    // (some IAM configurations don't allow SimulatePrincipalPolicy)
    console.warn('Could not verify create permissions:', error.message);
    return {
      allowed: true,
      deniedActions: [],
      warning: 'Could not verify permissions',
    };
  }
};

// IAM permission checking for delete operations
const checkDeletePermissions = async () => {
  try {
    // Get current user ARN
    const identityCommand = new GetCallerIdentityCommand({});
    const identity = await stsClient.send(identityCommand);

    const requiredActions = [
      'ecs:DeleteService',
      'ecs:UpdateService',
      'ecs:DeregisterTaskDefinition',
      'ecr:DeleteRepository',
      'logs:DeleteLogGroup',
      'elasticloadbalancing:DeleteTargetGroup',
      'elasticloadbalancing:DeleteRule',
    ];

    const simulateCommand = new SimulatePrincipalPolicyCommand({
      PolicySourceArn: identity.Arn,
      ActionNames: requiredActions,
    });

    const result = await iamClient.send(simulateCommand);

    const deniedActions = result.EvaluationResults
      .filter(r => r.EvalDecision !== 'allowed')
      .map(r => r.EvalActionName);

    return {
      allowed: deniedActions.length === 0,
      deniedActions: deniedActions,
      userArn: identity.Arn,
    };
  } catch (error) {
    // If we can't check permissions, assume they have them
    // (some IAM configurations don't allow SimulatePrincipalPolicy)
    console.warn('Could not verify delete permissions:', error.message);
    return {
      allowed: true,
      deniedActions: [],
      warning: 'Could not verify permissions',
    };
  }
};

module.exports = {
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
  getMetricStatistics,
  createECRRepository,
  createTaskDefinitionForNewService,
  loadLoadBalancers,
  loadTargetGroups,
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
  listHostedZones,
  findHostedZoneForDomain,
  createRoute53Record,
  deleteRoute53Record,
  checkCreatePermissions,
  checkDeletePermissions,
  getAccountId,
};
