#!/usr/bin/env node

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const open = require('open');
const {
    loadAWSProfiles,
    loadRegions,
    loadRepositories,
    loadClusters,
    loadTaskDefinitions,
    loadServices,
    loadLoadBalancers,
    loadListeners,
} = require('./aws');

// Get configuration from environment
const WORKING_DIR = process.env.ECS_AWS_WORKING_DIR || process.cwd();
const PORT = parseInt(process.env.ECS_AWS_PORT) || 3000;
const defaultProfile = process.env.ECS_AWS_DEFAULT_PROFILE || null;

// Import existing functionality from index.js (relative to web-manager location)
const indexPath = path.join(__dirname, 'index.js');
const {
    getServiceDashboard,
    deployService,
    forceDeployService,
    scaleService,
    getServiceLogs,
    getServiceEvents,
    deleteServicePermission,
    deleteServiceCommand,
    loadAWSProfile,
    checkService
} = require(indexPath);

// Override the loadConfigFile function to use working directory
const loadConfigFileFromWorkingDir = (filename) => {
    const configPath = path.join(WORKING_DIR, filename);
    return new Promise((resolve, reject) => {
        fs.readFile(configPath, 'utf8', (err, data) => {
            if (err) {
                reject(new Error(`Could not load the configuration file: ${filename}`));
            } else {
                resolve(data);
            }
        });
    });
};

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

function normalizeProfileName(profileName = '') {
    if (!profileName || profileName === 'default') {
        return '';
    }

    return String(profileName).replace(/^_+/, '');
}

function getConfigFileNameForProfile(profileName = '') {
    const normalizedProfile = normalizeProfileName(profileName);
    return `ECSConfig${normalizedProfile ? `_${normalizedProfile}` : ''}.json`;
}

// Serve static files
app.use(express.static(path.join(__dirname, 'web')));
app.use(express.json());

// Store active log streams per socket
const logStreams = new Map();
const operationJobs = new Map();

// Track connected clients for cleanup
let connectedClients = 0;

function createOperationJob(type, profile) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const job = {
        id,
        type,
        profile,
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        events: [],
        error: null,
    };
    operationJobs.set(id, job);
    return job;
}

function addJobEvent(jobId, level, message) {
    const job = operationJobs.get(jobId);
    if (!job) return;

    job.events.push({
        timestamp: new Date().toISOString(),
        level,
        message,
    });
    job.updatedAt = new Date().toISOString();
}

function finishJob(jobId, status, error = null) {
    const job = operationJobs.get(jobId);
    if (!job) return;

    job.status = status;
    job.error = error;
    job.updatedAt = new Date().toISOString();
}

// Get available profiles from working directory
function getProfilesFromWorkingDir() {
    try {
        const configFiles = fs.readdirSync(WORKING_DIR)
            .filter(file => file.startsWith('ECSConfig') && file.endsWith('.json'));

        return configFiles.map(file => {
            const match = file.match(/^ECSConfig(?:_([^.]+))?\.json$/);
            return match ? (match[1] || 'default') : file;
        });
    } catch (error) {
        console.error('Error reading working directory:', error.message);
        return [];
    }
}

// Override functions to use working directory
const getServiceInfoFromWorkingDir = async (profileName) => {
    try {
        const configFileName = getConfigFileNameForProfile(profileName);

        const configData = await loadConfigFileFromWorkingDir(configFileName);
        const config = JSON.parse(configData);

        const hasService = typeof config.service === 'string' && config.service.trim().length > 0;

        if (!hasService) {
            return {
                serviceName: config.service_name || 'Not deployed',
                status: 'Not deployed',
                taskDefinition: 'N/A',
                taskDefinitionVersion: 'N/A',
                runningCount: 0,
                desiredCount: 0,
                pendingCount: 0,
                platformVersion: 'N/A',
                createdAt: null,
                lastDeploymentAt: null,
                config,
            };
        }

        // Load AWS profile first
        await loadAWSProfile(config);

        // Get service details from AWS
        const serviceInfo = await checkService(config.cluster, config.service);
        const service = serviceInfo?.services?.[0];
        const taskDefinitionArn = service?.taskDefinition || 'N/A';
        let taskDefinition = taskDefinitionArn;
        let taskDefinitionVersion = 'N/A';

        if (taskDefinitionArn !== 'N/A' && taskDefinitionArn.includes('task-definition/')) {
            const taskDefWithVersion = taskDefinitionArn.split('task-definition/')[1];
            const [taskDefName, taskDefVersion] = taskDefWithVersion.split(':');
            taskDefinition = taskDefName || taskDefWithVersion;
            taskDefinitionVersion = taskDefVersion || 'N/A';
        }

        return {
            serviceName: service?.serviceName || config.service_name || config.service,
            status: service?.status || 'Unknown',
            taskDefinition,
            taskDefinitionVersion,
            runningCount: service?.runningCount || 0,
            desiredCount: service?.desiredCount || 0,
            pendingCount: service?.pendingCount || 0,
            platformVersion: service?.platformVersion || 'N/A',
            createdAt: service?.createdAt || null,
            lastDeploymentAt: service?.deployments?.[0]?.updatedAt || null,
            config: config
        };
    } catch (error) {
        throw new Error(`Failed to get service info: ${error.message}`);
    }
};

// API Routes
app.get('/api/default-profile', (_req, res) => {
    const availableProfiles = getProfilesFromWorkingDir();
    const normalizedDefaultProfile = normalizeProfileName(defaultProfile || 'default') || 'default';
    const profileExists = availableProfiles.includes(normalizedDefaultProfile);

    res.json({
        defaultProfile: defaultProfile,
        workingDirectory: WORKING_DIR,
        availableProfiles,
        profileExists,
        configFileName: getConfigFileNameForProfile(defaultProfile || 'default'),
    });
});

app.get('/api/wizard/bootstrap/:profile', async (req, res) => {
    try {
        const requestedProfile = req.params.profile || 'default';
        const normalizedProfile = normalizeProfileName(requestedProfile) || 'default';
        const configFileName = getConfigFileNameForProfile(requestedProfile);
        const configPath = path.join(WORKING_DIR, configFileName);

        let awsProfiles = [];
        try {
            awsProfiles = loadAWSProfiles() || [];
        } catch (error) {
            awsProfiles = [];
        }

        res.json({
            requestedProfile: normalizedProfile,
            configFileName,
            configExists: fs.existsSync(configPath),
            awsProfiles,
            workingDirectory: WORKING_DIR,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/wizard/dockerfile', async (req, res) => {
    try {
        const dockerfilePath = String(req.query.path || '').trim();
        if (!dockerfilePath) {
            return res.status(400).json({ error: 'Missing required query param: path' });
        }

        const resolvedPath = path.resolve(WORKING_DIR, dockerfilePath);
        const normalizedWorkingDir = path.resolve(WORKING_DIR) + path.sep;

        if (!resolvedPath.startsWith(normalizedWorkingDir) && resolvedPath !== path.resolve(WORKING_DIR)) {
            return res.status(400).json({ error: 'Invalid Dockerfile path' });
        }

        if (!fs.existsSync(resolvedPath)) {
            return res.json({ exists: false, path: dockerfilePath, content: '' });
        }

        const stat = await fs.promises.stat(resolvedPath);
        if (!stat.isFile()) {
            return res.json({ exists: false, path: dockerfilePath, content: '' });
        }

        const content = await fs.promises.readFile(resolvedPath, 'utf8');
        return res.json({ exists: true, path: dockerfilePath, content });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

app.get('/api/wizard/options', async (req, res) => {
    try {
        const awsProfile = normalizeProfileName(req.query.awsProfile || 'default');
        const region = req.query.region || 'eu-west-1';
        const cluster = req.query.cluster || '';

        await loadAWSProfile({ profile: awsProfile, region });

        const [regions, repositories, clusters, taskDefinitions, services] = await Promise.all([
            loadRegions().catch(() => []),
            loadRepositories().catch(() => []),
            loadClusters().catch(() => []),
            loadTaskDefinitions().catch(() => []),
            cluster ? loadServices(cluster).catch(() => []) : Promise.resolve([]),
        ]);

        res.json({
            regions: (regions || []).map(item => item.RegionName).filter(Boolean),
            repositories: (repositories || []).map(item => item.repositoryUri).filter(Boolean),
            clusters: clusters || [],
            taskDefinitions: taskDefinitions || [],
            services: services || [],
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/wizard/new-service/options', async (req, res) => {
    try {
        const awsProfile = normalizeProfileName(req.query.awsProfile || 'default');
        const region = req.query.region || 'eu-west-1';
        const loadBalancerArn = req.query.loadBalancerArn || '';

        await loadAWSProfile({ profile: awsProfile, region });

        const loadBalancers = await loadLoadBalancers().catch(() => []);
        const listeners = loadBalancerArn
            ? await loadListeners(loadBalancerArn).catch(() => [])
            : [];

        res.json({
            loadBalancers: (loadBalancers || [])
                .filter(lb => lb.Type === 'application')
                .map(lb => ({
                    arn: lb.LoadBalancerArn,
                    name: lb.LoadBalancerName,
                    dnsName: lb.DNSName,
                })),
            listeners: (listeners || []).map(listener => ({
                arn: listener.ListenerArn,
                port: listener.Port,
                protocol: listener.Protocol,
            })),
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

function buildWizardConfigFromPayload(payload = {}) {
    const isNewServiceMode = payload.serviceMode === 'new';
    const requiredFields = isNewServiceMode
        ? ['profile', 'region', 'cluster', 'dockerfile']
        : ['profile', 'region', 'repo', 'cluster', 'task', 'dockerfile'];
    const missingField = requiredFields.find(field => !payload[field]);
    if (missingField) {
        throw new Error(`Missing required field: ${missingField}`);
    }

    if (isNewServiceMode && !payload?.newService?.serviceName) {
        throw new Error('Missing required field: newService.serviceName');
    }

    const asNumber = (value, fallback) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    };

    const envArray = Array.isArray(payload.env)
        ? payload.env.filter(item => item && item.name)
        : [];

    const configData = {
        profile: normalizeProfileName(payload.profile),
        region: payload.region,
        repo: isNewServiceMode ? (payload.repo || '') : payload.repo,
        cluster: payload.cluster,
        task: isNewServiceMode ? payload.newService.serviceName : payload.task,
        service: payload.service || false,
        dockerfile: payload.dockerfile,
        log: payload.log || (isNewServiceMode ? `/ecs/${payload.newService.serviceName}` : payload.task),
        container_memory: asNumber(payload.container_memory, 128),
        cpu_units: asNumber(payload.cpu_units, 0),
        host_port: asNumber(payload.host_port, 0),
        app_port: asNumber(payload.app_port, 8080),
        local_port: asNumber(payload.local_port, 8080),
        env: envArray,
    };

    if (isNewServiceMode) {
        configData.new_service = {
            serviceName: payload.newService.serviceName,
            app_port: asNumber(payload.newService.app_port, 8080),
            loadBalancerArn: payload.newService.loadBalancerArn || '',
            listenerArn: payload.newService.listenerArn || '',
            healthCheckPath: payload.newService.healthCheckPath || '/',
            desiredCount: asNumber(payload.newService.desiredCount, 1),
            useHostname: !!payload.newService.useHostname,
            hostname: payload.newService.hostname || '',
        };
    }

    return configData;
}

app.post('/api/wizard/save/:profile', async (req, res) => {
    try {
        const requestedProfile = req.params.profile || 'default';
        const configFileName = getConfigFileNameForProfile(requestedProfile);
        const configPath = path.join(WORKING_DIR, configFileName);
        const payload = req.body || {};
        const configData = buildWizardConfigFromPayload(payload);

        const existed = fs.existsSync(configPath);
        await fs.promises.writeFile(configPath, JSON.stringify(configData), 'utf8');

        return res.status(existed ? 200 : 201).json({
            success: true,
            configFileName,
            profile: normalizeProfileName(requestedProfile) || 'default',
            mode: existed ? 'updated' : 'created',
        });
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }
});

app.post('/api/wizard/create/:profile', async (req, res) => {
    try {
        const requestedProfile = req.params.profile || 'default';
        const configFileName = getConfigFileNameForProfile(requestedProfile);
        const configPath = path.join(WORKING_DIR, configFileName);

        if (fs.existsSync(configPath)) {
            return res.status(409).json({ error: `${configFileName} already exists.` });
        }

        const payload = req.body || {};
        const configData = buildWizardConfigFromPayload(payload);

        await fs.promises.writeFile(configPath, JSON.stringify(configData), 'utf8');

        return res.status(201).json({
            success: true,
            configFileName,
            profile: normalizeProfileName(requestedProfile) || 'default',
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

app.get('/api/profiles', (_req, res) => {
    try {
        const profiles = getProfilesFromWorkingDir();
        res.json(profiles);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/config/:profile', async (req, res) => {
    try {
        const profile = req.params.profile;
        const configFileName = getConfigFileNameForProfile(profile);

        const configData = await loadConfigFileFromWorkingDir(configFileName);
        res.json(JSON.parse(configData));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/service/info/:profile', async (req, res) => {
    try {
        const profile = req.params.profile;
        const serviceInfo = await getServiceInfoFromWorkingDir(profile);
        res.json(serviceInfo);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/service/dashboard/:profile', async (req, res) => {
    try {
        const profile = req.params.profile;
        const dashboardData = await getServiceDashboard(profile);
        res.json(dashboardData);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/service/deploy/:profile', async (req, res) => {
    try {
        const profile = req.params.profile;
        const result = await deployService(profile, {
            nonInteractive: true,
            skipNpmRebuild: true
        });
        res.json({ success: true, result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/service/permissions/:profile', async (req, res) => {
    try {
        const profile = req.params.profile;
        const permissions = await deleteServicePermission(profile);
        res.json(permissions);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/operations/deploy/:profile', async (req, res) => {
    const profile = req.params.profile;
    const requestedTag = req.body?.tag;
    const job = createOperationJob('deploy', profile);

    addJobEvent(job.id, 'info', 'Deployment started');
    res.status(202).json({ jobId: job.id });

    deployService(profile, {
        nonInteractive: true,
        skipNpmRebuild: true,
        tagOverride: requestedTag,
        onProgress: (message) => addJobEvent(job.id, 'info', message),
    })
        .then(() => {
            addJobEvent(job.id, 'success', 'Deployment completed successfully');
            finishJob(job.id, 'success');
        })
        .catch((error) => {
            addJobEvent(job.id, 'error', error.message);
            finishJob(job.id, 'failed', {
                message: error.message,
                code: error.code,
                tag: error.tag,
            });
        });
});

app.post('/api/operations/force-deploy/:profile', async (req, res) => {
    const profile = req.params.profile;
    const job = createOperationJob('force-deploy', profile);

    addJobEvent(job.id, 'info', 'Force deployment started');
    res.status(202).json({ jobId: job.id });

    forceDeployService(profile, {
        nonInteractive: true,
        onProgress: (message) => addJobEvent(job.id, 'info', message),
    })
        .then(() => {
            addJobEvent(job.id, 'success', 'Force deployment triggered successfully');
            finishJob(job.id, 'success');
        })
        .catch((error) => {
            addJobEvent(job.id, 'error', error.message);
            finishJob(job.id, 'failed', {
                message: error.message,
                code: error.code,
            });
        });
});

app.post('/api/operations/scale/:profile', async (req, res) => {
    const profile = req.params.profile;
    const desiredCount = req.body?.desiredCount;
    const job = createOperationJob('scale', profile);

    addJobEvent(job.id, 'info', `Scaling service to desired count ${desiredCount}`);
    res.status(202).json({ jobId: job.id });

    scaleService(profile, desiredCount, {
        nonInteractive: true,
        onProgress: (message) => addJobEvent(job.id, 'info', message),
    })
        .then(() => {
            addJobEvent(job.id, 'success', `Desired count updated to ${desiredCount}`);
            finishJob(job.id, 'success');
        })
        .catch((error) => {
            addJobEvent(job.id, 'error', error.message);
            finishJob(job.id, 'failed', {
                message: error.message,
                code: error.code,
            });
        });
});

app.post('/api/operations/delete/:profile', async (req, res) => {
    const profile = req.params.profile;
    const confirmServiceName = req.body?.confirmServiceName;
    const confirmPhrase = req.body?.confirmPhrase;
    const job = createOperationJob('delete', profile);

    addJobEvent(job.id, 'info', 'Deletion started');
    res.status(202).json({ jobId: job.id });

    deleteServiceCommand(profile, {
        nonInteractive: true,
        confirmServiceName,
        confirmPhrase,
        deleteConfig: false,
        onProgress: (message) => addJobEvent(job.id, 'info', message),
    })
        .then(() => {
            addJobEvent(job.id, 'success', 'Deletion completed');
            finishJob(job.id, 'success');
        })
        .catch((error) => {
            addJobEvent(job.id, 'error', error.message);
            finishJob(job.id, 'failed', {
                message: error.message,
                code: error.code,
            });
        });
});

app.get('/api/operations/:jobId', (req, res) => {
    const jobId = req.params.jobId;
    const job = operationJobs.get(jobId);

    if (!job) {
        return res.status(404).json({ error: 'Operation not found' });
    }

    return res.json(job);
});

app.get('/api/service/logs/:profile', async (req, res) => {
    try {
        const profile = req.params.profile;
        const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
        const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
        const logs = await getServiceLogs(profile, { offset, limit });
        res.json(logs);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/service/events/:profile', async (req, res) => {
    try {
        const profile = req.params.profile;
        const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
        const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
        const events = await getServiceEvents(profile, { offset, limit });
        res.json(events);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/service/:profile', async (_req, res) => {
    res.status(400).json({ error: 'Use /api/operations/delete/:profile for delete operations in web manager.' });
});

// Real-time log streaming via Socket.IO
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    connectedClients++;

    // Cancel any scheduled shutdown
    if (shutdownTimer) {
        clearTimeout(shutdownTimer);
        shutdownTimer = null;
    }

    socket.on('start-log-tail', (profile) => {
        const normalizedProfile = normalizeProfileName(profile);
        console.log(`Starting log tail for profile: ${normalizedProfile || 'default'}`);

        // Stop any existing log stream for this socket
        if (logStreams.has(socket.id)) {
            logStreams.get(socket.id).kill();
        }

        // Start new log tail process
        const profileArg = normalizedProfile || 'default';
        const logProcess = spawn('node', [path.join(__dirname, 'index.js'), 'tail', '--profile', profileArg], {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        logStreams.set(socket.id, logProcess);

        logProcess.stdout.on('data', (data) => {
            socket.emit('log-data', data.toString());
        });

        logProcess.stderr.on('data', (data) => {
            socket.emit('log-error', data.toString());
        });

        logProcess.on('close', (code) => {
            console.log(`Log tail process exited with code ${code}`);
            logStreams.delete(socket.id);
        });
    });

    socket.on('stop-log-tail', () => {
        if (logStreams.has(socket.id)) {
            logStreams.get(socket.id).kill();
            logStreams.delete(socket.id);
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        connectedClients--;

        if (logStreams.has(socket.id)) {
            logStreams.get(socket.id).kill();
            logStreams.delete(socket.id);
        }

        // Schedule shutdown if no clients are connected
        scheduleShutdownIfEmpty();
    });
});

// Auto-shutdown when no clients are connected
let shutdownTimer = null;

function scheduleShutdownIfEmpty() {
    if (connectedClients <= 0) {
        console.log('No clients connected. Scheduling shutdown in 30 seconds...');
        shutdownTimer = setTimeout(() => {
            if (connectedClients <= 0) {
                console.log('🔄 No clients connected for 30 seconds. Auto-shutting down...');
                gracefulShutdown();
            }
        }, 30000); // 30 seconds delay
    }
}

function gracefulShutdown() {
    console.log('\nShutting down gracefully...');

    try {
        io.emit('server-shutdown');
    } catch (error) {
        // Ignore broadcast issues during shutdown
    }

    // Kill all active log streams
    for (const [_socketId, process] of logStreams) {
        try {
            process.kill('SIGTERM');
        } catch (error) {
            // Process might already be dead, ignore error
        }
    }
    logStreams.clear();

    // Close all socket connections
    io.close();

    // Close server with timeout
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });

    // Force exit after 5 seconds if graceful shutdown fails
    setTimeout(() => {
        console.log('Force closing...');
        process.exit(1);
    }, 5000);
}

// Serve the main HTML file
app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'web', 'index.html'));
});

// Start server and open browser
server.listen(PORT, () => {
    console.log(`🚀 ECS-AWS Web Manager running on http://localhost:${PORT}`);
    console.log(`📁 Working directory: ${WORKING_DIR}`);
    console.log(`👤 Auto-loading profile: ${defaultProfile}`);

    const profiles = getProfilesFromWorkingDir();
    console.log(`📋 Available profiles: ${profiles.join(', ')}`);
    console.log('💡 The server will automatically shutdown when the browser is closed.\n');

    setTimeout(() => {
        open(`http://localhost:${PORT}`);
    }, 1000);

    // Start monitoring for empty connections after initial period
    setTimeout(() => {
        scheduleShutdownIfEmpty();
    }, 60000); // Wait 1 minute before starting to monitor
});

// Graceful shutdown on SIGINT
process.on('SIGINT', gracefulShutdown);

module.exports = app;