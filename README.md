# Cyrus Panel Daemon

> The node-side daemon powering Cyrus Panel. Built for reliable server management, container control, and infrastructure operations.

[![License](https://img.shields.io/github/license/HasenDev/cyrus-daemon)](https://github.com/HasenDev/cyrus-daemon/blob/main/LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/HasenDev/cyrus-daemon?style=flat)](https://github.com/HasenDev/cyrus-daemon/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/HasenDev/cyrus-daemon)](https://github.com/HasenDev/cyrus-daemon/issues)

## Setting up the environment

Cyrus Panel Daemon requires **Node.js v21 or newer** as well as system utilities for archive and compression management.

**Node.js v24.19.0 is the currently tested version**, but it is not required.

### Required System Dependencies

The daemon relies on `unzip` and `tar` utilities to extract, inspect, and package server archives safely. Install them based on your Linux distribution:

**Debian / Ubuntu**

```bash
sudo apt update
sudo apt install -y unzip tar
```

**Fedora / RHEL / Rocky / AlmaLinux**

```bash
sudo dnf install -y unzip tar
```

**Arch Linux**

```bash
sudo pacman -S unzip tar
```

**Alpine Linux**

```bash
apk add unzip tar
```

**openSUSE**

```bash
sudo zypper install -y unzip tar
```

---

### Install Node.js with NVM

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 24.19.0
nvm use 24.19.0
```

### Or install Node.js using your Linux distribution

**Debian / Ubuntu**

```bash
sudo apt update
sudo apt install -y nodejs npm
```

**Fedora / RHEL / Rocky / AlmaLinux**

```bash
sudo dnf install -y nodejs npm
```

**Arch Linux**

```bash
sudo pacman -S nodejs npm
```

> Make sure your installed Node.js version is **v21 or newer**.

## Installation

Clone the repository and install the dependencies:

```bash
git clone https://github.com/HasenDev/cyrus-daemon.git
cd cyrus-daemon
npm install
```

## Building

Build the daemon into a standalone binary:

```bash
npm run build
```

The generated binary can then be used to run the daemon without requiring Node.js to be installed on the target machine.

## Development

To run the daemon directly from the source code:

```bash
npm run start
```

## Links

* **Website:** https://cyrus.admibot.xyz
* **Documentation:** https://cyrus.admibot.xyz/docs
* **Bug Reports:** https://cyrus.admibot.xyz/bugs
* **Support Server:** https://discord.gg/3yuMkSnrFd

## License

See the [LICENSE](https://github.com/HasenDev/cyrus-daemon/blob/main/LICENSE) file.
