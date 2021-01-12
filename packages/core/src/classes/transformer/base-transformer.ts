import {EntityTarget, INDEX_TYPE, Table} from '@typedorm/common';
import {getConstructorForInstance} from '../../helpers/get-constructor-for-instance';
import {isEmptyObject} from '../../helpers/is-empty-object';
import {isObject} from '../../helpers/is-object';
import {isScalarType} from '../../helpers/is-scalar-type';
import {parseKey} from '../../helpers/parse-key';
import {Connection} from '../connection/connection';
import {IsAutoGeneratedAttributeMetadata} from '../metadata/auto-generated-attribute-metadata';
import {
  DynamoEntityIndexesSchema,
  DynamoEntitySchema,
  DynamoEntitySchemaPrimaryKey,
} from '../metadata/entity-metadata';

export abstract class BaseTransformer {
  constructor(protected connection: Connection) {}
  /**
   * Returns table name decorated for given entity class
   * @param entityClass Entity Class
   */
  getTableNameForEntity<Entity>(entityClass: EntityTarget<Entity>) {
    const metadata = this.connection.getEntityByTarget(entityClass);

    return metadata.table.name;
  }

  /**
   * Transforms entity to dynamo db entity schema
   * @param entity Entity to transform to DynamoDB entity type
   */
  toDynamoEntity<Entity>(entity: Entity) {
    const entityClass = getConstructorForInstance(entity);
    // retrieve metadata and parse it to schema
    const metadata = this.connection.getEntityByTarget(entityClass);

    //  auto populate generated values
    this.connection.getAttributesForEntity(entityClass).forEach(attr => {
      if (IsAutoGeneratedAttributeMetadata(attr)) {
        entity = Object.assign({...entity, [attr.name]: attr.value});
      }
    });

    const parsedSchema: DynamoEntitySchema = this.recursiveParseEntity(
      metadata.schema,
      entity
    );

    // drop any extra keys that are on entity schema
    const normalizedPrimaryKey = this.getParsedPrimaryKey(
      metadata.table,
      metadata.schema.primaryKey,
      entity
    );

    const indexes = {
      ...parsedSchema.indexes,
    } as DynamoEntityIndexesSchema;

    // normalize indexes to non nested keys and drop other extra keys
    const normalizedIndexes = Object.keys(indexes).reduce((acc, key) => {
      const index = indexes[key];

      const tableIndexSignature = metadata.table.getIndexByKey(
        index.metadata._name ?? ''
      );
      // remove all other metadata from indexes
      const onlyKeysIndex = (index => {
        if (
          index.metadata.type === INDEX_TYPE.GSI &&
          tableIndexSignature.type === INDEX_TYPE.GSI
        ) {
          return {
            [tableIndexSignature.partitionKey]:
              index.attributes[tableIndexSignature.partitionKey],
            [tableIndexSignature.sortKey]:
              index.attributes[tableIndexSignature.sortKey],
          };
        } else if (
          index.metadata.type === INDEX_TYPE.LSI &&
          tableIndexSignature.type === INDEX_TYPE.LSI
        ) {
          return {
            [tableIndexSignature.sortKey]:
              index.attributes[tableIndexSignature.sortKey],
          };
        } else {
          return index;
        }
      })(index);

      acc = {...acc, ...onlyKeysIndex};
      return acc;
    }, {});

    // clone and cleanup any redundant keys
    const formattedSchema = {
      ...normalizedPrimaryKey,
      ...normalizedIndexes,
    };

    return {...entity, ...formattedSchema};
  }

  /**
   * Returns all affected indexes for given attributes
   * @param entityClass Entity class
   * @param attributes Attributes to check affected indexes for
   * @param options
   */
  getAffectedIndexesForAttributes<PrimaryKey, Entity>(
    entityClass: EntityTarget<Entity>,
    attributes: {
      [key in keyof Omit<Entity, keyof PrimaryKey>]?: any;
    } & {[key: string]: any},
    options?: {nestedKeySeparator: string}
  ) {
    const nestedKeySeparator = options?.nestedKeySeparator ?? '.';
    const {
      schema: {indexes},
    } = this.connection.getEntityByTarget(entityClass);

    const affectedIndexes = Object.keys(attributes).reduce(
      (acc, attrKey: string) => {
        const currAttrValue = attributes[attrKey];
        // if current value is not if scalar type skip checking index
        if (
          attrKey.includes(nestedKeySeparator) ||
          !isScalarType(currAttrValue)
        ) {
          return acc;
        }

        if (!indexes) {
          return acc;
        }

        Object.keys(indexes).forEach(key => {
          const currIndex = indexes[key];
          const interpolationsForCurrIndex =
            currIndex.metadata._interpolations ?? {};

          // if current index does not have any interpolations to resolve, move onto next one
          if (isEmptyObject(interpolationsForCurrIndex)) {
            return acc;
          }

          // check if attribute we are looking to update is referenced by any index
          Object.keys(interpolationsForCurrIndex).forEach(interpolationKey => {
            const currentInterpolation =
              interpolationsForCurrIndex[interpolationKey];

            if (currentInterpolation.includes(attrKey)) {
              const parsedIndex = parseKey(
                currIndex.attributes[interpolationKey],
                attributes
              );
              acc[interpolationKey] = parsedIndex;
            }
          });
        });

        return acc;
      },
      {} as any
    );
    return affectedIndexes;
  }

  /**
   * Returns a primary key of an entity
   * @param entityClass Class of entity
   * @param attributes Attributes to parse into primary key
   */
  getParsedPrimaryKey<Entity>(
    table: Table,
    primaryKey: DynamoEntitySchemaPrimaryKey,
    attributes: {[key in keyof Entity]: any}
  ) {
    return this.recursiveParseEntity(primaryKey.attributes, attributes);
  }

  /**
   * Recursively parses all keys of given object and replaces placeholders with matching values
   * @private
   * @param schema schema to resolve
   * @param entity entity to resolve schema against
   */
  protected recursiveParseEntity<Entity>(
    schema: any,
    entity: Entity,
    isSparse = false
  ) {
    const parsedSchema = Object.keys(schema).reduce((acc, key) => {
      const currentValue = schema[key];
      if (isObject(currentValue)) {
        acc[key] = this.recursiveParseEntity(
          currentValue,
          entity,
          !!currentValue.isSparse
        );
      } else {
        const parsedKey = parseKey(currentValue, entity, {
          isSparseIndex: isSparse,
        });

        // do not include sparse indexes in acc
        if (parsedKey) {
          acc[key] = parsedKey;
        }
      }
      return acc;
    }, {} as any);

    return parsedSchema;
  }
}
