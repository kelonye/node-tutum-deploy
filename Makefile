IMAGE=kelonye/tutum-deploy

build:
	@docker build -t $(IMAGE) .

push:
	@$(MAKE) build
	@docker push $(IMAGE)

.PHONY: push build
