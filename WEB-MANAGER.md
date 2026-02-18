# ECS-AWS Web Manager

A web-based interface for managing AWS ECS services, providing an intuitive alternative to command-line operations.

## Features

- 📊 **Service Information**: View real-time service status, task counts, and configuration details
- 🚀 **One-Click Deployment**: Deploy services with visual feedback and progress indicators
- 📋 **Log Management**: View historical logs and tail real-time logs with clean formatting
- ⚡ **Event Monitoring**: Monitor ECS service events and status changes
- 🗑️ **Service Deletion**: Safely delete services with confirmation dialogs
- 🔄 **Profile Management**: Switch between multiple ECS configuration profiles
- 📱 **Responsive Design**: Works on desktop and mobile devices

## Quick Start

1. **Install dependencies** (if not already installed):

   ```bash
   npm install express socket.io open
   ```

2. **Launch the web interface**:

   ```bash
   ecs-aws web
   ```

3. **Access the interface**:
   - Automatically opens in your default browser

## Usage

### Profile Selection

1. Select your ECS configuration profile from the dropdown
2. Click "Load Profile" to initialize the interface
3. Use "Refresh" to reload available profiles

### Service Management

- **Deploy**: Build and deploy your service to ECS
- **View Logs**: See recent service logs with timestamps
- **Tail Logs**: Stream real-time logs (with stop/start controls)
- **Events**: Monitor ECS service events and changes
- **Delete**: Remove service and associated resources (with confirmation)

### Real-time Features

- Live log streaming via WebSocket connections
- Automatic service status updates
- Visual progress indicators for long-running operations
- Error handling with detailed error messages

## Requirements

- Node.js 14+
- Existing ecs-aws installation and configuration
- AWS credentials configured via AWS CLI
- Required npm packages: `express`, `socket.io`, `open`

## Security Notes

- Runs locally only (localhost:3000)
- Uses existing AWS credentials from ecs-aws configuration
- No additional authentication required (inherits AWS permissions)
- All operations subject to existing IAM permission checks
