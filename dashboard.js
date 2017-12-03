var timeAgo = require('node-time-ago');
var colors = require("colors");
var moment = require("moment");

module.exports = function(arroProfileData) {
  var iSecondInterval = 20;
  // return getServiceData(arroProfileData).then(function(data){console.log(data.services[0])});

  var blessed = require('blessed'),
    contrib = require('blessed-contrib'),
    screen = blessed.screen(),
    grid = new contrib.grid({
      rows: 12,
      cols: 12,
      screen: screen
    })

  screen.key(['escape', 'q', 'C-c'], function(ch, key) {
    return process.exit(0);
  });

  //Service logs;
  var log = grid.set(0, 4, 6, 8, contrib.log, {
    fg: "black",
    selectedFg: "green",
    label: 'Logs'
  })

  log.log(colors.green("Please wait while the logs are loading..."))
  //end service logs

  //Service events;
  var eventLogs = grid.set(6, 4, 6, 8, contrib.log, {
    fg: "black",
    selectedFg: "green",
    label: 'Events'
  })

  eventLogs.log(colors.green("Please wait while the events are loading..."))
  //end service logs

  //Service info
  var table = grid.set(0, 0, 3, 4, contrib.table, {
    keys: false,
    fg: 'black',
    selectedFg: 'black',
    interactive: false,
    label: 'Service "' + arroProfileData.service.split("service/")[1] + '" Information (updated every ' + iSecondInterval + ' seconds)',
    border: {
      type: "line",
      fg: "black"
    },
    columnSpacing: 1 //in chars
      ,
    columnWidth: [20, 30] /*in chars*/
  })

  screen.render()

  table.setData({
    headers: [''],
    data: [
      [colors.green.bold("loading information...")]
    ]
  })

  screen.render();
  //end service info



  var fGetMetrics = function(p_sMetricName, line) {
    fGetStats(arroProfileData, p_sMetricName).then(function(data) {

      var times = data.map(function(d) {
        return moment(d.Timestamp).format("HH:mm")
      });
      line.setData([{
          title: "Average",
          x: times,
          y: data.map(function(d) {
            return d.Average
          }),
          style: {
            line: 'green'
          }
        },
        {
          title: "Minimum",
          x: times,
          y: data.map(function(d) {
            return d.Minimum
          }),
          style: {
            line: 'yellow'
          }
        },
        {
          title: "Maximum",
          x: times,
          y: data.map(function(d) {
            return d.Maximum
          }),
          style: {
            line: 'red'
          }
        }
      ]);

      screen.render();
      setTimeout(function() {
        fGetMetrics(p_sMetricName, line)
      }, iSecondInterval * 1000)
    })
  }

  //Metrics

  var line = grid.set(6, 0, 3, 4, contrib.line, {
    style: {
      line: "yellow",
      text: "green",
      baseline: "green",
      bg: 'black'
    },
    xLabelPadding: 3,
    xPadding: 5,
    showLegend: false,
    wholeNumbersOnly: false //true=do not show fraction in y axis
      ,
    label: 'CPUUtilization (%)'
  })

  fGetMetrics("CPUUtilization", line)

  //Metrics2

  var line2 = grid.set(9, 0, 3, 4, contrib.line, {
    style: {
      line: "yellow",
      text: "green",
      baseline: "green",
      bg: 'black'
    },
    xLabelPadding: 3,
    xPadding: 5,
    showLegend: false,
    wholeNumbersOnly: false //true=do not show fraction in y axis
      ,
    label: 'MemoryUtilization (%)'
  })

  fGetMetrics("MemoryUtilization", line2)

  //service info data
  var fGetInfo = function() {
    getServiceData(arroProfileData).then(function(data) {
      var oService = data.services[0];
      table.setData({
        headers: ['', ''],
        data: [
          [colors.red.bold("Service name"), oService.serviceName],
          [colors.red.bold("Task definition"), oService.taskDefinition.split("task-definition/")[1]],
          [colors.red.bold("Desired tasks"), oService.desiredCount],
          [colors.red.bold("Running tasks"), oService.runningCount],
          [colors.red.bold("Pending tasks"), oService.pendingCount],
          [colors.red.bold("Created"), moment(oService.createdAt).format("DD MMMM YYYY @ HH:mm:ss")],
          [colors.red.bold("Deployed"), moment(oService.deployments[0].updatedAt).format("DD MMMM YYYY @ HH:mm:ss")]
        ]
      })

      for (let i = 0;i < oService.events.length ; i++) {
        var oEvent = oService.events[i];
        eventLogs.log(colors.red(moment(oEvent.createdAt).format("MMM DD HH:mm:ss")) + ":\t" + oEvent.message)
      }

      screen.render();
      setTimeout(function() {
        fGetInfo();
      }, iSecondInterval * 1000);
    })
  }

  fGetInfo();

  // logs update
  var g_logs = function(){
    fGetLogs(arroProfileData).then(function(logs) {
      for (var i = 0; i < logs.length; i++) {
        log.log(colors.red(moment(logs[i][0]).format("MMM DD HH:mm:ss")) + ":\t" + logs[i][1])
      }

      screen.render();

      setTimeout(function() {
        log.log(colors.green("Fetching logs..."))
        g_logs();
      }, iSecondInterval * 1000)
    })
  }
  g_logs();


}
