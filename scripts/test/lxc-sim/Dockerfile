# Simulated Proxmox community-script cross-seed LXC (Debian 12 + systemd + Node 24 + cross-seed 6.13.9 as root).
# docker build -t csui-lxc-sim scripts/test/lxc-sim
# docker run -d --name csui-a --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw -p 12470:2470 csui-lxc-sim
# docker cp release/cross-seed-ui-X.tar.gz csui-a:/root/ && docker exec csui-a bash /root/install.sh --role both --tarball /root/cross-seed-ui-X.tar.gz -y
FROM debian:12
ENV container=docker DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv curl ca-certificates build-essential python3 procps && rm -rf /var/lib/apt/lists/*
# like community-scripts cross-seed-install.sh: Node 24 + npm i -g cross-seed + gen-config + root service
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*
RUN npm install -g cross-seed@6.13.9 && cross-seed gen-config
RUN printf '[Unit]\nDescription=cross-seed daemon Service\nAfter=network.target\n\n[Service]\nUser=root\nExecStart=/usr/bin/cross-seed daemon\nRestart=on-failure\nRestartSec=30\n\n[Install]\nWantedBy=multi-user.target\n' > /etc/systemd/system/cross-seed.service && systemctl enable cross-seed.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
