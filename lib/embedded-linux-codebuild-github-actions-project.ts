import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as codepipeline_actions from "aws-cdk-lib/aws-codepipeline-actions";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as efs from "aws-cdk-lib/aws-efs";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as path from "path";

import {
  BuildEnvironmentVariableType,
  BuildSpec,
  ComputeType,
  FileSystemLocation,
  LinuxBuildImage,
  Project,
  Source,
  FilterGroup,
  EventAction,
} from "aws-cdk-lib/aws-codebuild";
import { IRepository } from "aws-cdk-lib/aws-ecr";

import {
  ISecurityGroup,
  IVpc,
  Peer,
  Port,
  SecurityGroup,
} from "aws-cdk-lib/aws-ec2";
import { SourceRepo, ProjectKind } from "./constructs/source-repo";
import { VMImportBucket } from "./vm-import-bucket";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { RemovalPolicy } from "aws-cdk-lib";

/**
 * Properties to allow customizing the build.
 */
export interface EmbeddedLinuxCodebuildGitHubActionsProjectProps
  extends cdk.StackProps {
  /** ECR Repository where the Build Host Image resides. */
  readonly imageRepo: IRepository;
  /** Tag for the Build Host Image */
  readonly imageTag?: string;
  /** VPC where the networking setup resides. */
  readonly vpc: IVpc;
  /** The type of project being built.  */
  readonly projectKind?: ProjectKind;
  /** A name for the layer-repo that is created. Default is 'layer-repo' */
  readonly layerRepoName?: string;
  /** Additional policy statements to add to the build project. */
  readonly buildPolicyAdditions?: iam.PolicyStatement[];
}

/**
 * The stack for creating a build pipeline.
 *
 * See {@link EmbeddedLinuxCodebuildGitHubActionsProjectProps} for configration options.
 */
export class EmbeddedLinuxCodebuildGitHubActionsProjectStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: EmbeddedLinuxCodebuildGitHubActionsProjectProps
  ) {
    super(scope, id, props);

    /** Set up networking access and EFS FileSystems. */

    const projectSg = new SecurityGroup(this, "BuildProjectSecurityGroup", {
      vpc: props.vpc,
      description: "Security Group to allow attaching EFS",
    });
    projectSg.addIngressRule(
      Peer.ipv4(props.vpc.vpcCidrBlock),
      Port.tcp(2049),
      "NFS Mount Port"
    );

    const sstateFS = this.addFileSystem("SState", props.vpc, projectSg);
    const dlFS = this.addFileSystem("Downloads", props.vpc, projectSg);
    const tmpFS = this.addFileSystem("Temp", props.vpc, projectSg);

    let outputBucket: s3.IBucket | VMImportBucket;
    let environmentVariables = {};
    let scriptAsset!: Asset;

    const accessLoggingBucket = new s3.Bucket(this, "ArtifactAccessLogging", {
      versioned: true,
      enforceSSL: true,
    });

    outputBucket = new s3.Bucket(this, "PipelineOutput", {
        versioned: true,
        enforceSSL: true,
        serverAccessLogsBucket: accessLoggingBucket,
      });

    const encryptionKey = new kms.Key(this, "PipelineArtifactKey", {
      removalPolicy: RemovalPolicy.DESTROY,
      enableKeyRotation: true,
    });
    const artifactBucket = new s3.Bucket(this, "PipelineArtifacts", {
      versioned: true,
      enforceSSL: true,
      serverAccessLogsBucket: accessLoggingBucket,
      encryptionKey,
      encryption: s3.BucketEncryption.KMS,
      blockPublicAccess: new s3.BlockPublicAccess(
        s3.BlockPublicAccess.BLOCK_ALL
      ),
    });

    /** Create our CodeBuild Project. */
    const project = new Project(
      this,
      "EmbeddedLinuxCodebuildGitHubActionsProject",
      {
        buildSpec: BuildSpec.fromObject({
          version: '0.2',
          phases: {
            build: {
              commands: [
                'echo "DUMMY BUILDSPEC"'
              ]
            }
          },
          artifacts: {
            files: ['**/*'],
            'base-directory': '.'
          }
        }),
        environment: {
          computeType: ComputeType.X2_LARGE,
          buildImage: LinuxBuildImage.fromEcrRepository(
            props.imageRepo,
            props.imageTag
          ),
          privileged: true,
          environmentVariables,
        },
        timeout: cdk.Duration.hours(4),
        vpc: props.vpc,
        securityGroups: [projectSg],
        fileSystemLocations: [
          FileSystemLocation.efs({
            identifier: "tmp_dir",
            location: tmpFS,
            mountPoint: "/build-output",
          }),
          FileSystemLocation.efs({
            identifier: "sstate_cache",
            location: sstateFS,
            mountPoint: "/sstate-cache",
          }),
          FileSystemLocation.efs({
            identifier: "dl_dir",
            location: dlFS,
            mountPoint: "/downloads",
          }),
        ],
        logging: {
          cloudWatch: {
            logGroup: new LogGroup(this, "PipelineBuildLogs", {
              retention: RetentionDays.TEN_YEARS,
            }),
          },
        },
      }
    );

    if (props.buildPolicyAdditions) {
      props.buildPolicyAdditions.map((p) => project.addToRolePolicy(p));
    }

    project.addToRolePolicy(this.addProjectPolicies());

    // project.role?.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'));
    project.role?.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCodeBuildAdminAccess'));

    /** Here we create the logic to check for presence of ECR image on the CodePipeline automatic triggering upon resource creation,
     * and stop the execution if the image does not exist.  */
    const fnOnPipelineCreate = new lambda.Function(
      this,
      "OSImageCheckOnStart",
      {
        runtime: lambda.Runtime.PYTHON_3_10,
        handler: "index.handler",
        code: lambda.Code.fromInline(`
import boto3
import json

ecr_client = boto3.client('ecr')
codepipeline_client = boto3.client('codepipeline')

def handler(event, context):
  print("Received event: " + json.dumps(event, indent=2))
  response = ecr_client.describe_images(repositoryName='${props.imageRepo.repositoryName}', filter={'tagStatus': 'TAGGED'})
  for i in response['imageDetails']:
    if '${props.imageTag}' in i['imageTags']:
      break
  else:
    print('OS image not found. Stopping execution.')
    response = codepipeline_client.stop_pipeline_execution(
    pipelineName=event['detail']['pipeline'],
    pipelineExecutionId=event['detail']['execution-id'],
    abandon=True,
    reason='OS image not found in ECR repository. Stopping pipeline until image is present.')
    `),
        logRetention: RetentionDays.TEN_YEARS,
      }
    );

    const pipelineCreateRule = new events.Rule(this, "OnPipelineStartRule", {
      eventPattern: {
        detailType: ["CodePipeline Pipeline Execution State Change"],
        source: ["aws.codepipeline"],
        detail: {
          state: ["STARTED"],
          "execution-trigger": {
            "trigger-type": ["CreatePipeline"],
          },
        },
      },
    });
    pipelineCreateRule.addTarget(
      new targets.LambdaFunction(fnOnPipelineCreate)
    );

    //}
    const ecrPolicy = new iam.PolicyStatement({
      actions: ["ecr:DescribeImages"],
      resources: [props.imageRepo.repositoryArn],
    });
  }

  /**
   * Adds an EFS FileSystem to the VPC and SecurityGroup.
   *
   * @param name - A name to differentiate the filesystem.
   * @param vpc - The VPC the Filesystem resides in.
   * @param securityGroup - A SecurityGroup to allow access to the filesystem from.
   * @returns The filesystem location URL.
   *
   */
  private addFileSystem(
    name: string,
    vpc: IVpc,
    securityGroup: ISecurityGroup
  ): string {
    const fs = new efs.FileSystem(
      this,
      `EmbeddedLinuxPipeline${name}Filesystem`,
      {
        vpc,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }
    );
    fs.connections.allowFrom(securityGroup, Port.tcp(2049));

    const fsId = fs.fileSystemId;
    const region = cdk.Stack.of(this).region;

    return `${fsId}.efs.${region}.amazonaws.com:/`;
  }

  private addProjectPolicies(): iam.PolicyStatement {
    return new iam.PolicyStatement({
      actions: [
        'ec2:DescribeSecurityGroups',
        'codestar-connections:GetConnection',
				'codestar-connections:GetConnectionToken',
				'codeconnections:GetConnectionToken',
				'codeconnections:GetConnection',
				'codeconnections:UseConnection',
        'codebuild:ListConnectedOAuthAccounts',
        'codebuild:ListRepositories',
        'codebuild:PersistOAuthToken',
        'codebuild:ImportSourceCredentials',
      ],
      resources: ['*'],
    });
  }
}
