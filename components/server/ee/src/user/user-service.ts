/**
 * Copyright (c) 2020 Gitpod GmbH. All rights reserved.
 * Licensed under the Gitpod Enterprise Source Code License,
 * See License.enterprise.txt in the project root folder.
 */

import { UserService, CheckSignUpParams, CheckTermsParams } from "../../../src/user/user-service";
import {
    User,
    WorkspaceTimeoutDuration,
    WORKSPACE_TIMEOUT_EXTENDED,
    WORKSPACE_TIMEOUT_EXTENDED_ALT,
    WORKSPACE_TIMEOUT_DEFAULT_LONG,
    WORKSPACE_TIMEOUT_DEFAULT_SHORT,
} from "@gitpod/gitpod-protocol";
import { inject } from "inversify";
import { LicenseEvaluator } from "@gitpod/licensor/lib";
import { Feature } from "@gitpod/licensor/lib/api";
import { AuthException } from "../../../src/auth/errors";
import { EligibilityService } from "./eligibility-service";
import { SubscriptionService } from "@gitpod/gitpod-payment-endpoint/lib/accounting";
import { OssAllowListDB } from "@gitpod/gitpod-db/lib/oss-allowlist-db";
import { HostContextProvider } from "../../../src/auth/host-context-provider";
import { Config } from "../../../src/config";

export class UserServiceEE extends UserService {
    @inject(LicenseEvaluator) protected readonly licenseEvaluator: LicenseEvaluator;
    @inject(EligibilityService) protected readonly eligibilityService: EligibilityService;
    @inject(SubscriptionService) protected readonly subscriptionService: SubscriptionService;
    @inject(OssAllowListDB) protected readonly OssAllowListDb: OssAllowListDB;
    @inject(HostContextProvider) protected readonly hostContextProvider: HostContextProvider;
    @inject(Config) protected readonly config: Config;

    async getDefaultWorkspaceTimeout(user: User, date: Date): Promise<WorkspaceTimeoutDuration> {
        if (this.config.enablePayment) {
            // the SaaS case
            return this.eligibilityService.getDefaultWorkspaceTimeout(user, date);
        }

        const userCount = await this.userDb.getUserCount(true);

        // the self-hosted case
        if (!this.licenseEvaluator.isEnabled(Feature.FeatureSetTimeout, userCount)) {
            return WORKSPACE_TIMEOUT_DEFAULT_SHORT;
        }

        return WORKSPACE_TIMEOUT_DEFAULT_LONG;
    }

    public workspaceTimeoutToDuration(timeout: WorkspaceTimeoutDuration): string {
        switch (timeout) {
            case WORKSPACE_TIMEOUT_DEFAULT_SHORT:
                return "10m";
            case WORKSPACE_TIMEOUT_DEFAULT_LONG:
                return this.config.workspaceDefaults.timeoutDefault || "5m";
            case WORKSPACE_TIMEOUT_EXTENDED:
            case WORKSPACE_TIMEOUT_EXTENDED_ALT:
                return this.config.workspaceDefaults.timeoutExtended || "180m";
        }
    }

    public durationToWorkspaceTimeout(duration: string): WorkspaceTimeoutDuration {
        switch (duration) {
            case "10m":
                return WORKSPACE_TIMEOUT_DEFAULT_SHORT;
            case this.config.workspaceDefaults.timeoutDefault || "5m":
                return WORKSPACE_TIMEOUT_DEFAULT_LONG;
            case this.config.workspaceDefaults.timeoutExtended || "180m":
                return WORKSPACE_TIMEOUT_EXTENDED_ALT;
            default:
                return WORKSPACE_TIMEOUT_DEFAULT_SHORT;
        }
    }

    async userGetsMoreResources(user: User): Promise<boolean> {
        if (this.config.enablePayment) {
            return this.eligibilityService.userGetsMoreResources(user);
        }

        return false;
    }

    async checkSignUp(params: CheckSignUpParams) {
        // todo@at: check if we need an optimization for SaaS here. used to be a no-op there.

        // 1. check the license
        const userCount = await this.userDb.getUserCount(true);
        if (!this.licenseEvaluator.hasEnoughSeats(userCount)) {
            const msg = `Maximum number of users permitted by the license exceeded`;
            throw AuthException.create("Cannot sign up", msg, { userCount, params });
        }

        // 2. check defaults
        await super.checkSignUp(params);
    }

    async checkTermsAcceptanceRequired(params: CheckTermsParams): Promise<boolean> {
        ///////////////////////////////////////////////////////////////////////////
        // Currently, we don't check for ToS on login.
        ///////////////////////////////////////////////////////////////////////////

        return false;
    }

    async checkTermsAccepted(user: User) {
        // called from GitpodServer implementation

        ///////////////////////////////////////////////////////////////////////////
        // Currently, we don't check for ToS on Gitpod API calls.
        ///////////////////////////////////////////////////////////////////////////

        return true;
    }

    async checkAutomaticOssEligibility(user: User): Promise<boolean> {
        const idsWithHost = user.identities
            .map((id) => {
                const hostContext = this.hostContextProvider.findByAuthProviderId(id.authProviderId);
                if (!hostContext) {
                    return undefined;
                }
                const info = hostContext.authProvider.info;
                return `${info.host}/${id.authName}`;
            })
            .filter((i) => !!i) as string[];

        return this.OssAllowListDb.hasAny(idsWithHost);
    }
}
