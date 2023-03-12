import { ColumnNode, FilterExpressionNode, InsertQueryNode, KyselyPlugin, OperationNodeTransformer, PluginTransformQueryArgs, PluginTransformResultArgs, SelectQueryNode } from "kysely"
import { callOrGet, ValueOrFactory } from "value-or-factory"
import { TableMatch, TableMatcher } from "./matcher"

export type Discriminator = { table: TableMatch, columns: ValueOrFactory<Record<string, unknown>, [InsertQueryNode | SelectQueryNode]> }

export type DiscriminatorTransformerConfig = {
    discriminator: Discriminator
    throwOnUnsupported?: boolean
}

export class DiscriminatorTransformer extends OperationNodeTransformer {

    private readonly tableMatcher

    constructor(private readonly config: DiscriminatorTransformerConfig) {
        super()
        this.tableMatcher = new TableMatcher(config.discriminator.table)
    }

    protected override transformInsertQuery(originalNode: InsertQueryNode): InsertQueryNode {
        const node = super.transformInsertQuery(originalNode)
        if (!this.tableMatcher.test(node.into.table.identifier.name, node.into.table.schema?.name)) {
            return node
        }
        if (node.values?.kind !== "ValuesNode") {
            if (this.config.throwOnUnsupported ?? true) {
                throw new Error("This type of ValuesNode is not supported by the DiscriminatorPlugin.")
            }
            return node
        }
        return {
            ...node,
            onConflict: (() => {
                if (node.onConflict === undefined) {
                    return
                }
                const newOnConflict = {
                    ...node.onConflict,
                    columns: [
                        ...node.onConflict.columns ?? [],
                        ...Object.entries(callOrGet(this.config.discriminator.columns, node)).map<ColumnNode>(([column]) => {
                            return {
                                kind: "ColumnNode",
                                column: {
                                    kind: "IdentifierNode",
                                    name: column,
                                }
                            }
                        })
                    ]
                }
                return newOnConflict
            })()
        }
    }

    protected override transformSelectQuery(originalNode: SelectQueryNode): SelectQueryNode {
        const node = super.transformSelectQuery(originalNode)
        const fromTables = node.from.froms.flatMap(from => {
            if (from.kind === "TableNode") {
                return {
                    table: from.table.identifier.name,
                    schema: from.table.schema?.name
                }
            }
            else if (from.alias.kind === "IdentifierNode") {
                //TODO how do i get schema?
                return []
            }
            else {
                return []
            }
        })
        const eqNodes = [
            ...fromTables.flatMap(table => {
                if (!this.tableMatcher.test(table.table, table.schema)) {
                    return []
                }
                return Object.entries(callOrGet(this.config.discriminator.columns, node)).map<FilterExpressionNode>(([column, value]) => {
                    return {
                        kind: "FilterNode",
                        left: {
                            kind: "ReferenceNode",
                            table: {
                                kind: "TableNode",
                                table: {
                                    kind: "SchemableIdentifierNode",
                                    identifier: {
                                        kind: "IdentifierNode",
                                        name: table.table
                                    },
                                    ...(() => {
                                        if (table.schema !== undefined) {
                                            return {
                                                schema: {
                                                    kind: "IdentifierNode",
                                                    name: table.schema
                                                }
                                            }
                                        }
                                    })()
                                }
                            },
                            column: {
                                kind: "ColumnNode",
                                column: {
                                    kind: "IdentifierNode",
                                    name: column,
                                }
                            }
                        },
                        op: {
                            kind: "OperatorNode",
                            operator: "="
                        },
                        right: {
                            kind: "ValueNode",
                            value: value
                        }
                    }
                })
            }),
            ...(node.where?.where ? [node.where?.where] : []),
        ]
        const filterNode = eqNodes.reduce<FilterExpressionNode | undefined>((prev, current) => {
            if (prev === undefined) {
                return current
            }
            return {
                kind: "AndNode",
                left: prev,
                right: current,
            }
        }, undefined)
        if (filterNode === undefined) {
            return node
        }
        else {
            return {
                ...node,
                where: {
                    kind: "WhereNode",
                    where: filterNode
                }
            }
        }
    }

}

export type DiscriminatorPluginOptions = { tables: Discriminator[], throwOnUnsupported?: boolean }

export class DiscriminatorPlugin implements KyselyPlugin {

    private readonly transformers

    constructor(options: DiscriminatorPluginOptions) {
        this.transformers = options.tables.map(discriminator => {
            return new DiscriminatorTransformer({ discriminator, throwOnUnsupported: options.throwOnUnsupported })
        })
    }

    transformQuery(args: PluginTransformQueryArgs) {
        return this.transformers.reduce((node, transformer) => transformer.transformNode(node), args.node)
    }
    async transformResult(args: PluginTransformResultArgs) {
        return args.result
    }

}
