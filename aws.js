const { ECSClient, DescribeServicesCommand, RegisterTaskDefinitionCommand, UpdateServiceCommand, DescribeTaskDefinitionCommand, DescribeClustersCommand, ListClustersCommand, ListTaskDefinitionFamiliesCommand, ListServicesCommand, CreateServiceCommand, DeleteServiceCommand, DeregisterTaskDefinitionCommand, WaiterState, waitUntilServicesStable } = require('@aws-sdk/client-ecs');
const { CloudWatchLogsClient, DescribeLogStreamsCommand, GetLogEventsCommand, DescribeLogGroupsCommand, CreateLogGroupCommand, DeleteLogGroupCommand } = require('@aws-sdk/client-cloudwatch-logs');
const { CloudWatchClient, GetMetricStatisticsCommand } = require('@aws-sdk/client-cloudwatch');
const { ECRClient, DescribeImagesCommand, DescribeRepositoriesCommand, CreateRepositoryCommand, DeleteRepositoryCommand } = require('@aws-sdk/client-ecr');
const { EC2Client, DescribeRegionsCommand } = require('@aws-sdk/client-ec2');
const { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand, DescribeTargetGroupsCommand, DescribeTargetHealthCommand, DescribeListenersCommand, CreateTargetGroupCommand, CreateRuleCommand, DescribeRulesCommand, DeleteTargetGroupCommand, DeleteRuleCommand } = require('@aws-sdk/client-elastic-load-balancing-v2');
const { Route53Client, ListHostedZonesCommand, ChangeResourceRecordSetsCommand } = require('@aws-sdk/client-route-53');
const { IAMClient, SimulatePrincipalPolicyCommand, ListRolesCommand, CreateRoleCommand, PutRolePolicyCommand } = require('@aws-sdk/client-iam');
const { EventBridgeClient, PutRuleCommand, PutTargetsCommand, RemoveTargetsCommand, DeleteRuleCommand: DeleteEventRuleCommand, DescribeRuleCommand, ListTargetsByRuleCommand } = require('@aws-sdk/client-eventbridge');
const { SchedulerClient, CreateScheduleCommand, UpdateScheduleCommand, GetScheduleCommand, DeleteScheduleCommand } = require('@aws-sdk/client-scheduler');
const { toScheduleExpression } = require('./cron');
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
let eventBridgeClient = new EventBridgeClient({});
let schedulerClient = new SchedulerClient({});

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
  return (data.logStreams || [])
    .map(oStream => oStream.logStreamName)
    .filter(logStreamName => typeof logStreamName === 'string' && logStreamName.length > 0);
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
    eventBridgeClient = new EventBridgeClient({ region, credentials });
    schedulerClient = new SchedulerClient({ region, credentials });

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

  if (!arroProfileData.service) {
    if (arroProfileData.schedule) {
      await upsertSchedule(arroProfileData, data.taskDefinition.taskDefinitionArn);
    }
    return data;
  }

  const params = {
    service: arroProfileData.service,
    taskDefinition: data.taskDefinition.taskDefinitionArn,
    cluster: arroProfileData.cluster,
  };

  const updateCommand = new UpdateServiceCommand(params);
  return ecsClient.send(updateCommand);
};

// ===== Scheduled tasks (cronjobs) =====
// config.schedule = { type: 'rule' | 'scheduler', cron, timezone, role_arn, name }
//   rule      = classic EventBridge rule targeting ECS ("ECS scheduled task"), always UTC
//   scheduler = EventBridge Scheduler, supports timezones
const SCHEDULE_TARGET_ID = 'ecs-aws';
const SCHEDULE_PRINCIPALS = {
  rule: 'events.amazonaws.com',
  scheduler: 'scheduler.amazonaws.com',
};

const getScheduleName = arroProfileData => (arroProfileData.schedule && arroProfileData.schedule.name)
  || String(arroProfileData.task || '').replace(/[^\w.-]/g, '-').substring(0, 64);

const getLatestTaskDefinitionArn = async (family) => {
  const data = await ecsClient.send(new DescribeTaskDefinitionCommand({ taskDefinition: family }));
  return data.taskDefinition.taskDefinitionArn;
};

const scheduleEcsParameters = taskDefinitionArn => ({
  TaskDefinitionArn: taskDefinitionArn,
  TaskCount: 1,
  LaunchType: 'EC2',
});

// Creates or updates the schedule so it runs `taskDefinitionArn` (defaults to the latest revision of config.task)
const upsertSchedule = async (arroProfileData, taskDefinitionArn) => {
  const schedule = arroProfileData.schedule;
  if (!schedule || !schedule.cron) {
    throw new Error('No schedule configured');
  }
  if (!schedule.role_arn) {
    throw new Error('Schedule has no IAM role (role_arn)');
  }
  const name = getScheduleName(arroProfileData);
  const taskArn = taskDefinitionArn || await getLatestTaskDefinitionArn(arroProfileData.task);
  const expression = toScheduleExpression(schedule.cron);

  const notFound = (err) => {
    if (err.name === 'ResourceNotFoundException') return null;
    throw err;
  };

  if (schedule.type === 'scheduler') {
    // An existing schedule (possibly made in the console) keeps its own settings; only the cron, timezone,
    // role and task definition are replaced
    const existing = await schedulerClient.send(new GetScheduleCommand({ Name: name })).catch(notFound);
    const existingTarget = (existing && existing.Target) || {};
    const params = {
      Name: name,
      GroupName: existing ? existing.GroupName : undefined,
      ScheduleExpression: expression,
      ScheduleExpressionTimezone: schedule.timezone || 'UTC',
      FlexibleTimeWindow: existing ? existing.FlexibleTimeWindow : { Mode: 'OFF' },
      State: existing ? existing.State : 'ENABLED',
      Description: existing ? existing.Description : `ecs-aws: ${arroProfileData.task}`,
      StartDate: existing ? existing.StartDate : undefined,
      EndDate: existing ? existing.EndDate : undefined,
      KmsKeyArn: existing ? existing.KmsKeyArn : undefined,
      ActionAfterCompletion: existing ? existing.ActionAfterCompletion : undefined,
      Target: {
        ...existingTarget,
        Arn: arroProfileData.cluster,
        RoleArn: schedule.role_arn,
        EcsParameters: existing
          ? { ...existingTarget.EcsParameters, TaskDefinitionArn: taskArn }
          : scheduleEcsParameters(taskArn),
      },
    };
    await schedulerClient.send(existing ? new UpdateScheduleCommand(params) : new CreateScheduleCommand(params));
    return { name, type: 'scheduler', expression, taskDefinitionArn: taskArn, created: !existing };
  }

  // Rule: keep its state/description, and update the targets already running on this cluster instead of adding one
  const existingRule = await eventBridgeClient.send(new DescribeRuleCommand({ Name: name })).catch(notFound);
  const rule = await eventBridgeClient.send(new PutRuleCommand({
    Name: name,
    ScheduleExpression: expression,
    State: existingRule ? existingRule.State : 'ENABLED',
    Description: existingRule ? existingRule.Description : `ecs-aws: ${arroProfileData.task}`,
  }));
  const currentTargets = existingRule
    ? ((await eventBridgeClient.send(new ListTargetsByRuleCommand({ Rule: name }))).Targets || [])
      .filter(target => target.Arn === arroProfileData.cluster && target.EcsParameters)
    : [];
  const targetsToPut = currentTargets.length
    ? currentTargets.map(target => ({
      ...target,
      RoleArn: schedule.role_arn,
      EcsParameters: { ...target.EcsParameters, TaskDefinitionArn: taskArn },
    }))
    : [{
      Id: SCHEDULE_TARGET_ID,
      Arn: arroProfileData.cluster,
      RoleArn: schedule.role_arn,
      EcsParameters: scheduleEcsParameters(taskArn),
    }];
  const targets = await eventBridgeClient.send(new PutTargetsCommand({ Rule: name, Targets: targetsToPut }));
  if (targets.FailedEntryCount) {
    throw new Error(`Could not set schedule target: ${targets.FailedEntries.map(e => e.ErrorMessage).join(', ')}`);
  }
  return { name, type: 'rule', expression, taskDefinitionArn: taskArn, ruleArn: rule.RuleArn };
};

// Live state of the configured schedule in AWS: { exists, state, expression, timezone, taskDefinitionArn }
const getScheduleStatus = async (arroProfileData) => {
  const schedule = arroProfileData.schedule;
  if (!schedule) {
    return null;
  }
  const name = getScheduleName(arroProfileData);
  const notFound = (err) => {
    if (err.name === 'ResourceNotFoundException') return null;
    throw err;
  };

  if (schedule.type === 'scheduler') {
    const data = await schedulerClient.send(new GetScheduleCommand({ Name: name })).catch(notFound);
    if (!data) return { name, exists: false };
    return {
      name,
      exists: true,
      state: data.State,
      expression: data.ScheduleExpression,
      timezone: data.ScheduleExpressionTimezone || 'UTC',
      taskDefinitionArn: data.Target && data.Target.EcsParameters && data.Target.EcsParameters.TaskDefinitionArn,
    };
  }

  const rule = await eventBridgeClient.send(new DescribeRuleCommand({ Name: name })).catch(notFound);
  if (!rule) return { name, exists: false };
  const { Targets = [] } = await eventBridgeClient.send(new ListTargetsByRuleCommand({ Rule: name }));
  const target = Targets.find(t => t.Arn === arroProfileData.cluster && t.EcsParameters) || Targets[0];
  return {
    name,
    exists: true,
    state: rule.State,
    expression: rule.ScheduleExpression,
    timezone: 'UTC',
    taskDefinitionArn: target && target.EcsParameters && target.EcsParameters.TaskDefinitionArn,
  };
};

// Newest revision of a task definition family: { arn, revision, registeredAt }
const getLatestTaskDefinition = async (family) => {
  const data = await ecsClient.send(new DescribeTaskDefinitionCommand({ taskDefinition: family }));
  return {
    arn: data.taskDefinition.taskDefinitionArn,
    revision: data.taskDefinition.revision,
    registeredAt: data.taskDefinition.registeredAt,
  };
};

// Timestamp of the most recent log event in a log group (null when empty)
const getLastLogEventTime = async (logGroupName) => {
  const data = await cloudwatchlogsClient.send(new DescribeLogStreamsCommand({
    logGroupName,
    descending: true,
    limit: 1,
    orderBy: 'LastEventTime',
  }));
  const stream = (data.logStreams || [])[0];
  return stream && stream.lastEventTimestamp ? new Date(stream.lastEventTimestamp).toISOString() : null;
};

// Returns true when deleted (or already gone), false on failure, like the other delete helpers
const deleteSchedule = async (arroProfileData, schedule = arroProfileData.schedule) => {
  if (!schedule) {
    return true;
  }
  const name = getScheduleName({ ...arroProfileData, schedule });
  const notFound = err => err && err.name === 'ResourceNotFoundException';
  try {
    if (schedule.type === 'scheduler') {
      await schedulerClient.send(new DeleteScheduleCommand({ Name: name })).catch((err) => {
        if (!notFound(err)) throw err;
      });
      return true;
    }
    const exists = await eventBridgeClient.send(new DescribeRuleCommand({ Name: name }))
      .then(() => true)
      .catch((err) => {
        if (notFound(err)) return false;
        throw err;
      });
    if (exists) {
      const { Targets = [] } = await eventBridgeClient.send(new ListTargetsByRuleCommand({ Rule: name }));
      if (Targets.length) {
        await eventBridgeClient.send(new RemoveTargetsCommand({ Rule: name, Ids: Targets.map(target => target.Id) }));
      }
      await eventBridgeClient.send(new DeleteEventRuleCommand({ Name: name }));
    }
    return true;
  } catch (error) {
    console.error(`Error deleting schedule ${name}:`, error.message);
    return false;
  }
};

// IAM roles that the given schedule type is allowed to assume
const loadScheduleRoles = async (type) => {
  const principal = SCHEDULE_PRINCIPALS[type] || SCHEDULE_PRINCIPALS.rule;
  const roles = [];
  let Marker;
  do {
    const data = await iamClient.send(new ListRolesCommand({ Marker }));
    (data.Roles || []).forEach((role) => {
      const policy = decodeURIComponent(role.AssumeRolePolicyDocument || '');
      if (policy.includes(principal)) {
        roles.push({ name: role.RoleName, arn: role.Arn });
      }
    });
    Marker = data.IsTruncated ? data.Marker : undefined;
  } while (Marker);
  return roles;
};

// Creates a role the schedule can assume to run ECS tasks (ecs:RunTask + passing the task's roles)
const createScheduleRole = async (type, roleName) => {
  const principal = SCHEDULE_PRINCIPALS[type] || SCHEDULE_PRINCIPALS.rule;
  const data = await iamClient.send(new CreateRoleCommand({
    RoleName: roleName,
    Description: `Lets ${principal} run ECS tasks (created by ecs-aws)`,
    AssumeRolePolicyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { Service: principal }, Action: 'sts:AssumeRole' }],
    }),
  }));
  await iamClient.send(new PutRolePolicyCommand({
    RoleName: roleName,
    PolicyName: 'ecs-aws-run-task',
    PolicyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: 'ecs:RunTask', Resource: '*' },
        {
          Effect: 'Allow',
          Action: 'iam:PassRole',
          Resource: '*',
          Condition: { StringLike: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
        },
      ],
    }),
  }));
  return { name: data.Role.RoleName, arn: data.Role.Arn };
};

const forceNewDeployment = async (arroProfileData) => {
  if (!arroProfileData.service) {
    throw new Error('Force deployment is only available for ECS services');
  }

  const params = {
    service: arroProfileData.service,
    cluster: arroProfileData.cluster,
    forceNewDeployment: true,
  };

  const updateCommand = new UpdateServiceCommand(params);
  return ecsClient.send(updateCommand);
};

const updateDesiredCount = async (arroProfileData, desiredCount) => {
  if (!arroProfileData.service) {
    throw new Error('Scaling is only available for ECS services');
  }

  const normalizedCount = Number(desiredCount);
  if (!Number.isInteger(normalizedCount) || normalizedCount < 0) {
    throw new Error('Desired task count must be a non-negative integer');
  }

  const params = {
    service: arroProfileData.service,
    cluster: arroProfileData.cluster,
    desiredCount: normalizedCount,
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
  let nextToken;
  let logGroupExists = false;

  do {
    const describeCommand = new DescribeLogGroupsCommand({
      logGroupNamePrefix: arroProfileData.log,
      nextToken,
    });
    const data = await cloudwatchlogsClient.send(describeCommand);
    const logGroups = data.logGroups || [];

    if (logGroups.some(logGroup => logGroup.logGroupName === arroProfileData.log)) {
      logGroupExists = true;
      break;
    }

    nextToken = data.nextToken;
  } while (nextToken);

  if (logGroupExists) {
    return { created: false };
  }

  const params = {
    logGroupName: arroProfileData.log,
  };

  try {
    const createCommand = new CreateLogGroupCommand(params);
    await cloudwatchlogsClient.send(createCommand);
    return { created: true };
  } catch (err) {
    if (err && err.name === 'ResourceAlreadyExistsException') {
      return { created: false };
    }
    throw err;
  }
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

const describeTargetGroupByArn = async (targetGroupArn) => {
  if (!targetGroupArn) {
    return null;
  }

  const command = new DescribeTargetGroupsCommand({
    TargetGroupArns: [targetGroupArn],
  });
  const data = await elbv2Client.send(command);
  return (data.TargetGroups || [])[0] || null;
};

const describeTargetHealthSummary = async (targetGroupArn) => {
  if (!targetGroupArn) {
    return {
      healthy: 0,
      unhealthy: 0,
      initial: 0,
      draining: 0,
      unused: 0,
      unavailable: 0,
      unknown: 0,
      reasons: [],
    };
  }

  const command = new DescribeTargetHealthCommand({
    TargetGroupArn: targetGroupArn,
  });
  const data = await elbv2Client.send(command);
  const descriptions = data.TargetHealthDescriptions || [];

  const summary = {
    healthy: 0,
    unhealthy: 0,
    initial: 0,
    draining: 0,
    unused: 0,
    unavailable: 0,
    unknown: 0,
    reasons: [],
  };

  const reasonCounter = {};

  descriptions.forEach((item) => {
    const state = item?.TargetHealth?.State || 'unknown';
    if (Object.prototype.hasOwnProperty.call(summary, state)) {
      summary[state] += 1;
    } else {
      summary.unknown += 1;
    }

    const reason = item?.TargetHealth?.Reason;
    if (reason) {
      reasonCounter[reason] = (reasonCounter[reason] || 0) + 1;
    }
  });

  summary.reasons = Object.keys(reasonCounter)
    .map((reason) => ({ reason, count: reasonCounter[reason] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return summary;
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
  forceNewDeployment,
  updateDesiredCount,
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
  describeTargetGroupByArn,
  describeTargetHealthSummary,
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
  upsertSchedule,
  deleteSchedule,
  loadScheduleRoles,
  createScheduleRole,
  getScheduleName,
  getScheduleStatus,
  getLatestTaskDefinition,
  getLastLogEventTime,
};
