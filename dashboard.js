const colors = require('colors');
const moment = require('moment');
const blessed = require('blessed');
const contrib = require('blessed-contrib');

const { getServiceData, getLogStreams, getLogEvents, getMetricStatistics } = require('./aws');

const wait = iSecondInterval => uData => new Promise(resolve => setTimeout(() => {
  resolve(uData);
}, iSecondInterval * 1000));

const fGetLogs = (arroProfileData, seconds) => getLogStreams(arroProfileData.log)
  .then((arrsStreams) => {
    if (!arrsStreams || arrsStreams.length === 0) {
      return [];
    }

    arrsStreams.reverse();
    const arroPromises = [];
    const date = moment();

    date.subtract(seconds || 60 * 60, 'seconds');
    for (let i = 0; i < arrsStreams.length; i += 1) {
      arroPromises.push(getLogEvents(arroProfileData.log, arrsStreams[i], date.unix()));
    }

    return Promise.all(arroPromises)
      .then((arroData) => {
        const arroLog = [];

        for (let i = 0; i < arroData.length; i += 1) {
          Object.keys(arroData[i]).forEach((key) => {
            const arrsMessage = arroData[i][key];
            const oDate = new Date();
            oDate.setTime(key);
            arroLog.push([oDate, arrsMessage.join('\n')]);
          });
        }

        arroLog.sort((a, b) => moment.utc(b[0]).diff(moment.utc(a[0])));

        return arroLog.slice(0, 50); // Increased from 25 to 50 logs
      });
  })
  .catch((error) => {
    console.error('Error fetching logs:', error.message);
    return [[new Date(), `Error fetching logs: ${error.message}`]];
  });


const fGetStats = (arroProfileData, metricName) => {
  const params = {
    EndTime: new Date(),
    /* required */
    MetricName: metricName,
    /* required */
    Namespace: 'AWS/ECS',
    /* required */
    Period: 5,
    /* required */
    StartTime: moment().subtract(20, 'minutes').unix(),
    /* required */
    Dimensions: [{
      Name: 'ClusterName',
      /* required */
      Value: arroProfileData.cluster.split('cluster/')[1], /* required */
    },
    {
      Name: 'ServiceName',
      /* required */
      Value: arroProfileData.service.split('service/')[1], /* required */
    },
      /* more items */
    ],
    Statistics: [
      'Average',
      'Minimum',
      'Maximum',
      /* more items */
    ],
    Unit: 'Percent',
  };
  return getMetricStatistics(params);
};

module.exports = (arroProfileData) => {
  // return fGetLogs(arroProfileData).then(arroLogs => JSON.stringify(arroLogs,null,2)).then(console.log)
  const iSecondInterval = 5;

  const screen = blessed.screen({
    title: arroProfileData.task,
  });

  const grid = new contrib.grid({ // eslint-disable-line new-cap
    rows: 12,
    cols: 12,
    screen,
  });


  screen.key(['escape', 'q', 'C-c'], () => process.exit(0));

  // Service events;
  const eventLogs = grid.set(6, 4, 6, 8, contrib.log, {
    fg: 'black',
    selectedFg: 'green',
    label: 'Service Events',
  });

  if (arroProfileData.service) {
    eventLogs.log(colors.green('Please wait while the events are loading...'));
  } else {
    eventLogs.log(colors.yellow('Service events not available for scheduled tasks/cronjobs.'));
    eventLogs.log(colors.yellow('Check AWS EventBridge or ECS Scheduled Tasks for scheduling information.'));
  }
  // end service logs

  // Service info
  const table = grid.set(0, 0, 3, 4, contrib.table, {
    keys: false,
    fg: 'black',
    selectedFg: 'black',
    interactive: false,
    label: `Service "${arroProfileData.service ? arroProfileData.service.split('service/')[1] : arroProfileData.task}" Information (updated every ${iSecondInterval} seconds)`,
    border: {
      type: 'line',
      fg: 'black',
    },
    columnSpacing: 1, // in chars
    columnWidth: [20, 30], /* in chars */
  });

  // Resource Details box
  const resourceTable = grid.set(3, 0, 3, 4, contrib.table, {
    keys: false,
    fg: 'black',
    selectedFg: 'black',
    interactive: false,
    label: 'Resource Details',
    border: {
      type: 'line',
      fg: 'black',
    },
    columnSpacing: 1,
    columnWidth: [20, 50],
  });

  screen.render();

  table.setData({
    headers: [''],
    data: [
      [colors.green.bold('loading information...')],
    ],
  });

  resourceTable.setData({
    headers: [''],
    data: [
      [colors.green.bold('loading resource details...')],
    ],
  });

  screen.render();
  // end service info


  const getMetrics = (sMetricName, line) => fGetStats(arroProfileData, sMetricName).then((data) => {
    const times = data.map(d => moment(d.Timestamp).format('HH:mm'));
    line.setData([{
      title: 'Average',
      x: times,
      y: data.map(d => d.Average),
      style: {
        line: 'green',
      },
    },
    {
      title: 'Minimum',
      x: times,
      y: data.map(d => d.Minimum),
      style: {
        line: 'yellow',
      },
    },
    {
      title: 'Maximum',
      x: times,
      y: data.map(d => d.Maximum),
      style: {
        line: 'red',
      },
    },
    ]);

    return screen.render();
    // return setTimeout(() => {
    //   getMetrics(p_sMetricName, line);
    // }, iSecondInterval * 1000);
  })
    .then(wait(iSecondInterval))
    .then(() => getMetrics(sMetricName, line));

  // Metrics

  const line = grid.set(6, 0, 3, 4, contrib.line, {
    style: {
      line: 'yellow',
      text: 'green',
      baseline: 'green',
    },
    xLabelPadding: 3,
    xPadding: 5,
    showLegend: false,
    wholeNumbersOnly: false, // true=do not show fraction in y axis
    label: 'CPUUtilization (%)',
  });

  if (arroProfileData.service) {
    getMetrics('CPUUtilization', line);
  }

  // Metrics2

  const line2 = grid.set(9, 0, 3, 4, contrib.line, {
    style: {
      line: 'yellow',
      text: 'green',
      baseline: 'green',
    },
    xLabelPadding: 3,
    xPadding: 5,
    showLegend: false,
    wholeNumbersOnly: false, // true=do not show fraction in y axis
    label: 'MemoryUtilization (%)',
  });

  if (arroProfileData.service) {
    getMetrics('MemoryUtilization', line2);
  }

  // service info data
  const getInfo = () => {
    // Check if this is a service or a cronjob
    if (!arroProfileData.service) {
      // This is a cronjob/scheduled task
      table.setData({
        headers: ['', ''],
        data: [
          [colors.red.bold('Type'), 'Scheduled Task'],
          [colors.red.bold('Task definition'), arroProfileData.task],
          [colors.red.bold('Cluster'), arroProfileData.cluster ? arroProfileData.cluster.split('cluster/')[1] : 'N/A'],
          [colors.red.bold('Schedule'), 'See EventBridge'],
        ],
      });

      // Resource details for cronjob
      const resourceData = [];
      if (arroProfileData.cluster) {
        resourceData.push([colors.cyan.bold('Cluster ARN'), arroProfileData.cluster]);
      }
      if (arroProfileData.repo) {
        resourceData.push([colors.cyan.bold('ECR Repository'), arroProfileData.repo]);
      }
      if (arroProfileData.log) {
        resourceData.push([colors.cyan.bold('Log Group'), arroProfileData.log]);
      }
      if (arroProfileData.region) {
        resourceData.push([colors.cyan.bold('Region'), arroProfileData.region]);
      }
      resourceData.push([colors.cyan.bold('Schedule Info'), 'Check AWS EventBridge or ECS Scheduled Tasks']);

      resourceTable.setData({
        headers: ['', ''],
        data: resourceData,
      });

      screen.render();
      return wait(iSecondInterval)().then(getInfo);
    }

    // This is a regular ECS service
    return getServiceData(arroProfileData).then((data) => {
      const oService = data.services[0];

      // Basic service info (original format)
      table.setData({
        headers: ['', ''],
        data: [
          [colors.red.bold('Service name'), oService.serviceName],
          [colors.red.bold('Task definition'), oService.taskDefinition.split('task-definition/')[1]],
          [colors.red.bold('Desired tasks'), oService.desiredCount.toString()],
          [colors.red.bold('Running tasks'), oService.runningCount.toString()],
          [colors.red.bold('Pending tasks'), oService.pendingCount.toString()],
          [colors.red.bold('Created'), moment(oService.createdAt).format('DD MMM YYYY HH:mm:ss')],
          [colors.red.bold('Deployed'), moment(oService.deployments[0].updatedAt).format('DD MMM YYYY HH:mm:ss')],
        ],
      });

      // Resource details (ARNs, endpoints, etc.)
      const resourceData = [];

      // Add Service ARN
      resourceData.push([colors.cyan.bold('Service ARN'), oService.serviceArn]);

      // Add Task definition ARN
      resourceData.push([colors.cyan.bold('Task Def ARN'), oService.taskDefinition]);

      // Add Cluster ARN
      if (arroProfileData.cluster) {
        resourceData.push([colors.cyan.bold('Cluster ARN'), arroProfileData.cluster]);
      }

      // Add Target Group ARN if available
      if (oService.loadBalancers && oService.loadBalancers.length > 0) {
        const lb = oService.loadBalancers[0];
        if (lb.targetGroupArn) {
          resourceData.push([colors.cyan.bold('Target Group ARN'), lb.targetGroupArn]);
        }
      }

      // Add hostname and endpoint if available
      if (arroProfileData.hostname) {
        resourceData.push([colors.cyan.bold('Hostname'), arroProfileData.hostname]);
        resourceData.push([colors.green.bold('Endpoint'), `http://${arroProfileData.hostname}`]);
      }

      // Add load balancer DNS if available
      if (arroProfileData.loadBalancerDNSName) {
        resourceData.push([colors.cyan.bold('Load Balancer DNS'), arroProfileData.loadBalancerDNSName]);
        if (!arroProfileData.hostname) {
          resourceData.push([colors.green.bold('Endpoint'), `http://${arroProfileData.loadBalancerDNSName}`]);
        }
      }

      // Add ECR repository
      if (arroProfileData.repo) {
        resourceData.push([colors.cyan.bold('ECR Repository'), arroProfileData.repo]);
      }

      // Add log group
      if (arroProfileData.log) {
        resourceData.push([colors.cyan.bold('Log Group'), arroProfileData.log]);
      }

      // Add region
      if (arroProfileData.region) {
        resourceData.push([colors.cyan.bold('Region'), arroProfileData.region]);
      }

      resourceTable.setData({
        headers: ['', ''],
        data: resourceData,
      });

      // Update events log with better formatting
      if (oService.events && oService.events.length > 0) {
        for (let i = oService.events.length - 1; i >= 0; i -= 1) {
          const oEvent = oService.events[i];
          const timeStr = moment(oEvent.createdAt).format('MMM DD HH:mm:ss');
          const message = oEvent.message;

          // Color code based on message content
          if (message.includes('has reached a steady state') || message.includes('successfully')) {
            eventLogs.log(`${colors.green(timeStr)}:\t${colors.green(message)}`);
          } else if (message.includes('failed') || message.includes('error') || message.includes('unable')) {
            eventLogs.log(`${colors.red(timeStr)}:\t${colors.red(message)}`);
          } else {
            eventLogs.log(`${colors.yellow(timeStr)}:\t${message}`);
          }
        }
      }

      return screen.render();
    })
      .catch((error) => {
        table.setData({
          headers: ['', ''],
          data: [
            [colors.red.bold('Error'), `Failed to fetch service data: ${error.message}`],
          ],
        });
        resourceTable.setData({
          headers: ['', ''],
          data: [
            [colors.red.bold('Error'), 'Unable to load resource details'],
          ],
        });
        screen.render();
        return wait(iSecondInterval)().then(getInfo);
      })
      .then(wait(iSecondInterval))
      .then(getInfo);
  };

  getInfo();

  // service logs
  let log = grid.set(0, 4, 6, 8, contrib.log, {
    fg: 'black',
    selectedFg: 'green',
    label: 'Logs',
  });
  log.log(colors.green('Please wait while the logs are loading...'));
  // end service logs

  // logs update
  const getLogs = () => fGetLogs(arroProfileData)
    .then((arroLogs) => {
      log = grid.set(0, 4, 6, 8, contrib.log, {
        fg: 'black',
        selectedFg: 'green',
        label: `Logs (Last ${arroLogs.length} entries)`,
      });

      return arroLogs;
    })
    .then((arroLogs) => {
      if (arroLogs.length === 0) {
        log.log(colors.yellow('No logs available yet...'));
      } else {
        for (let i = 0; i < arroLogs.length; i += 1) {
          const timeStr = moment(arroLogs[i][0]).format('MMM DD HH:mm:ss');
          const message = arroLogs[i][1];

          // Color code based on log level keywords
          if (message.match(/ERROR|FATAL|CRITICAL/i)) {
            log.log(`${colors.red(timeStr)}:\t${colors.red(message)}`);
          } else if (message.match(/WARN|WARNING/i)) {
            log.log(`${colors.yellow(timeStr)}:\t${colors.yellow(message)}`);
          } else if (message.match(/INFO|SUCCESS/i)) {
            log.log(`${colors.green(timeStr)}:\t${message}`);
          } else if (message.match(/DEBUG|TRACE/i)) {
            log.log(`${colors.cyan(timeStr)}:\t${colors.gray(message)}`);
          } else {
            log.log(`${colors.blue(timeStr)}:\t${message}`);
          }
        }
      }

      return screen.render();
    })
    .catch((error) => {
      log.log(colors.red(`Error fetching logs: ${error.message}`));
      screen.render();
      return wait(iSecondInterval)();
    })
    .then(wait(iSecondInterval))
    .then(getLogs);

  getLogs();
};
