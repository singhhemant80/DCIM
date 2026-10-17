import type { BootKind } from './provisioning';

/**
 * Default unattended-install templates for uploaded ISOs. Each one sets the
 * host name, network, root password (only ever as a SHA-512 crypt hash) and
 * SSH keys, erases the first disk, and reports back to NexoraDC when it is
 * done so the job can verify the result. They are starting points: an image's
 * template can be edited on the OS & Images page.
 *
 * Variables: see TEMPLATE_VARIABLES in the API. {{#if x}} … {{/if}} blocks
 * are kept when the variable is non-empty.
 */

const UBUNTU = `#cloud-config
# NexoraDC autoinstall for {{imageName}} ({{hostname}})
autoinstall:
  version: 1
  locale: en_US.UTF-8
  keyboard:
    layout: us
  refresh-installer:
    update: no
  early-commands:
    - curl -fsS -m 20 -H 'Content-Type: application/json' -d '{"status":"started"}' '{{callbackUrl}}' || true
  network:
    version: 2
    ethernets:
      boot:
        match:
          macaddress: "{{mac}}"
{{#if dhcp}}        dhcp4: true
{{/if}}{{#if static}}        addresses: ["{{ip}}/{{prefix}}"]
{{#if gateway}}        routes:
          - to: default
            via: "{{gateway}}"
{{/if}}        nameservers:
          addresses: [{{nameserversCsv}}]
{{/if}}  storage:
    layout:
      name: lvm
      sizing-policy: all
  ssh:
    install-server: true
    allow-pw: {{#if rootPasswordHash}}true{{/if}}{{#if noPassword}}false{{/if}}
  user-data:
    hostname: {{shortname}}
    fqdn: {{hostname}}
    disable_root: false
    users:
      - name: root
        lock_passwd: {{#if rootPasswordHash}}false{{/if}}{{#if noPassword}}true{{/if}}
{{#if rootPasswordHash}}        hashed_passwd: "{{rootPasswordHash}}"
{{/if}}        ssh_authorized_keys: {{sshKeysJson}}
  late-commands:
{{#if rootPasswordHash}}    - echo 'PermitRootLogin yes' > /target/etc/ssh/sshd_config.d/10-nexoradc.conf
{{/if}}    - curl -fsS -m 30 -H 'Content-Type: application/json' -d '{"status":"done"}' '{{callbackUrl}}'
  error-commands:
    - curl -fsS -m 30 -H 'Content-Type: application/json' -d '{"status":"failed","message":"autoinstall reported an error"}' '{{callbackUrl}}'
`;

const KICKSTART = `# NexoraDC kickstart for {{imageName}} ({{hostname}})
# The install source comes from the inst.repo boot argument.
text
reboot
eula --agreed
lang en_US.UTF-8
keyboard us
timezone UTC --utc
firstboot --disable
{{#if dhcp}}network --bootproto=dhcp --device={{mac}} --hostname={{hostname}} --activate
{{/if}}{{#if static}}network --bootproto=static --device={{mac}} --ip={{ip}} --netmask={{netmask}}{{#if gateway}} --gateway={{gateway}}{{/if}}{{#if nameserversCsv}} --nameserver={{nameserversCsv}}{{/if}} --hostname={{hostname}} --activate
{{/if}}{{#if rootPasswordHash}}rootpw --iscrypted --allow-ssh {{rootPasswordHash}}
{{/if}}{{#if noPassword}}rootpw --lock
{{/if}}zerombr
clearpart --all --initlabel
autopart --type=lvm
bootloader

%packages
@core
curl
%end

%pre
curl -fsS -m 20 -H 'Content-Type: application/json' -d '{"status":"started"}' '{{callbackUrl}}' || true
%end

%post
mkdir -p /root/.ssh && chmod 700 /root/.ssh
echo '{{sshKeysBase64}}' | base64 -d >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
curl -fsS -m 30 -H 'Content-Type: application/json' -d '{"status":"done"}' '{{callbackUrl}}'
%end

%onerror
curl -fsS -m 30 -H 'Content-Type: application/json' -d '{"status":"failed","message":"kickstart reported an error"}' '{{callbackUrl}}'
%end
`;

// Static addresses are given on the kernel command line (NexoraDC adds them), so the
// installer already has its final address when it fetches this file.
const PRESEED = `# NexoraDC preseed for {{imageName}} ({{hostname}})
d-i debian-installer/locale string en_US.UTF-8
d-i keyboard-configuration/xkb-keymap select us
d-i netcfg/choose_interface select auto
d-i netcfg/get_hostname string {{shortname}}
d-i netcfg/get_domain string {{domain}}
d-i netcfg/hostname string {{shortname}}
d-i hw-detect/load_firmware boolean true
d-i mirror/country string manual
d-i mirror/http/hostname string deb.debian.org
d-i mirror/http/directory string /debian
d-i mirror/http/proxy string
d-i passwd/make-user boolean false
d-i passwd/root-login boolean true
{{#if rootPasswordHash}}d-i passwd/root-password-crypted password {{rootPasswordHash}}
{{/if}}{{#if noPassword}}d-i passwd/root-password-crypted password !
{{/if}}d-i clock-setup/utc boolean true
d-i time/zone string UTC
d-i clock-setup/ntp boolean true
d-i partman/early_command string debconf-set partman-auto/disk "$(list-devices disk | head -n1)"
d-i partman-auto/method string lvm
d-i partman-auto-lvm/guided_size string max
d-i partman-lvm/device_remove_lvm boolean true
d-i partman-md/device_remove_md boolean true
d-i partman-lvm/confirm boolean true
d-i partman-lvm/confirm_nooverwrite boolean true
d-i partman-auto/choose_recipe select atomic
d-i partman-partitioning/confirm_write_new_label boolean true
d-i partman/choose_partition select finish
d-i partman/confirm boolean true
d-i partman/confirm_nooverwrite boolean true
d-i partman-efi/non_efi_system boolean true
d-i apt-setup/cdrom/set-first boolean false
d-i apt-setup/non-free-firmware boolean true
tasksel tasksel/first multiselect standard, ssh-server
d-i pkgsel/include string curl openssh-server
d-i pkgsel/upgrade select none
popularity-contest popularity-contest/participate boolean false
d-i grub-installer/only_debian boolean true
d-i grub-installer/bootdev string default
d-i preseed/early_command string wget -q -O /dev/null --header='Content-Type: application/json' --post-data='{"status":"started"}' '{{callbackUrl}}' || true
d-i preseed/late_command string mkdir -p /target/root/.ssh; chmod 700 /target/root/.ssh; echo '{{sshKeysBase64}}' | base64 -d >> /target/root/.ssh/authorized_keys; chmod 600 /target/root/.ssh/authorized_keys;{{#if rootPasswordHash}} echo 'PermitRootLogin yes' > /target/etc/ssh/sshd_config.d/10-nexoradc.conf;{{/if}} in-target curl -fsS -m 30 -H 'Content-Type: application/json' -d '{"status":"done"}' '{{callbackUrl}}'
d-i finish-install/reboot_in_progress note
`;

const ESXI = `# NexoraDC ESXi kickstart for {{imageName}} ({{hostname}})
vmaccepteula
install --firstdisk --overwritevmfs
rootpw --iscrypted {{rootPasswordHash}}
{{#if dhcp}}network --bootproto=dhcp --device={{mac}} --hostname={{hostname}}
{{/if}}{{#if static}}network --bootproto=static --device={{mac}} --ip={{ip}} --netmask={{netmask}}{{#if gateway}} --gateway={{gateway}}{{/if}}{{#if nameserversCsv}} --nameserver={{nameserversCsv}}{{/if}} --hostname={{hostname}}
{{/if}}reboot

%firstboot --interpreter=busybox
vim-cmd hostsvc/enable_ssh
vim-cmd hostsvc/start_ssh
echo '{{sshKeysBase64}}' | base64 -d >> /etc/ssh/keys-root/authorized_keys
python -c "import urllib.request as u; u.urlopen(u.Request('{{callbackUrl}}', data=b'{\\"status\\":\\"done\\"}', headers={'Content-Type': 'application/json'}), timeout=30)"
`;

export interface DefaultTemplate {
  kind: 'kickstart' | 'preseed' | 'autoinstall' | 'esxi';
  template: string;
}

/** The template a newly uploaded ISO starts with (none for Proxmox, Windows and unknown ISOs: interactive only). */
export const DEFAULT_TEMPLATES: Partial<Record<BootKind, DefaultTemplate>> = {
  ubuntu: { kind: 'autoinstall', template: UBUNTU },
  rhel: { kind: 'kickstart', template: KICKSTART },
  debian: { kind: 'preseed', template: PRESEED },
  esxi: { kind: 'esxi', template: ESXI },
};
