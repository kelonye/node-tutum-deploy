Tutum deploy
===

[Fig](https://github.com/docker/fig) like deployment utility that uses [Tutum.co API](https://docs.tutum.co/v2/api/?shell#list-all-node-clusters) to manage multiple nodes and clusters.

Getting started
---

    $ npm install -g tutum-deploy

Create a `tutum.yaml` conf in the root of your project.

```yaml

---

clusters:

- name: us
  region: nyc1 # digital ocean
  type: 512mb
  nodes: 4

- name: eu
  region: ams2 # digital ocean
  type: 512mb
  nodes: 4

services:

- name: db
  image: mongodb
  containers: 1

- name: web
  image: user/web
  build: lib/web # Build user/web image on this path. Path should contain a Dockerfile.
  containers: 1
  ports:
    - guest: 80
      host: 80
      name: http
      protocol: tcp
      published: true
  env:
    - PORT: 80
  require: # Links.
    - db

```

- Sign up at [Tutum.co](http://tutum.co)
- Log into Tutum
- Link a platform e.g. [Digital Ocean](https://support.tutum.co/support/articles/5000012151-link-your-digital-ocean-account-to-tutum)
- Click on the menu on the upper right corner of the screen
- Select Account info
- Select Api Key
- Set the following env vars:
  - TUTUM_USER
  - TUTUM_APIKEY
- Deploy!
```bash
   $ td build
   $ td push
   $ td up
```

Variables
---

The configuration file can contain variables:

```yaml
- name: "{{APP_NAME}}"
  image: dockerfile/mongodb
  containers: 1
```

Values are then passed by prefixing variable names with `TUTUM_`:

    $ TUTUM_APP_NAME=dev td up


Service status
---

Use `td ps` to get the status of services.

```bash
    $ td ps
    tutum:deploy getting cluster app +0ms
    tutum:deploy cluster app state: Deployed +2s
    tutum:deploy getting service mongodb +1ms
    tutum:deploy cluster mongodb state: Running +2s
    tutum:deploy getting service user/web +1ms
    tutum:deploy cluster user/web state: Running +2s
```

Custom nodes
---

To manage custom nodes, add a `nodes` section as in the example below:

```yaml

nodes:

- uuid: 12345
```

Examples
---

- [Tweed](http://github.com/kelonye/tweed)
- [Redis cluster test](https://github.com/kelonye/redis-cluster-test)

Test
---

    $ make test

Todos
---

- Tests
- Removing a service entry should also delete it in Tutum/Host

Licence
---

  MIT