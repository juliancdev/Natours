const Tour = require('../models/tourModel');
const AppError = require('../utils/appError');
const multer = require('multer');
const sharp = require('sharp');

// const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const factory = require('./handlerFactory');
//tours handlers
//in a middleware param we have access to the 4th param which is the param value

const multerStorage = multer.memoryStorage(); //te upload now is happening to a buffer and not directly to the file system

const multerFilter = (req, file, callback) => {
  if (file.mimetype.startsWith('image')) {
    callback(null, true);
  } else {
    callback(
      new AppError('Not an image! Please upload only images.', 400),
      false
    );
  }
};

const upload = multer({ storage: multerStorage, fileFilter: multerFilter });

exports.uploadTourImages = upload.fields([
  { name: 'imageCover', maxCount: 1 },
  { name: 'images', maxCount: 3 },
]);

// upload.single('images', 5); produces req.file
// upload.array('images', 5); produces req.files

exports.resizeTourImages = catchAsync(async (req, res, next) => {
  // console.log(req.files);

  if (!req.files.imageCover || !req.files.images) return next();

  // 1) cover image

  req.body.imageCover = `tour-${req.params.id}-${Date.now()}-cover.jpeg`; //we use save to body trick so the next middleware will save to DB the image names because it saves what is in req.body
  await sharp(req.files.imageCover[0].buffer)
    .resize(2000, 1333, {}) // 3/2 ratio
    .toFormat('jpeg')
    .jpeg({ quality: 90 })
    .toFile(`public/img/tours/${req.body.imageCover}`);

  // 2) images
  req.body.images = []; //we use save to body trick so the next middleware will save to DB the image names because it saves what is in req.body
  //we use for each, but since the callback function is an async function, and an async function will return a new promise. So we change to .map() and save and array of all of these promises. And then if we have an array of promises, we can use Promise.all to await all of them
  await Promise.all(
    req.files.images.map(async (file, index) => {
      const filename = `tour-${req.params.id}-${Date.now()}-${index + 1}.jpeg`;

      await sharp(file.buffer)
        .resize(2000, 1333, {}) // 3/2 ratio
        .toFormat('jpeg')
        .jpeg({ quality: 90 })
        .toFile(`public/img/tours/${filename}`);

      req.body.images.push(filename); //we use save to body trick so the next middleware will save to DB the image names because it saves what is in req.body
    })
  );

  //only then, when all the image processing is done, we call next
  next();
});

exports.aliasTopTours = (req, res, next) => {
  //prefilling the query string
  req.query.limit = '5';
  req.query.sort = '-ratingsAverage, price';
  req.query.fields = 'name,price,ratingsAverage,summary,difficulty';
  next();
};

exports.getAllTours = factory.getAll(Tour);

exports.getTour = factory.getOne(Tour, { path: 'reviews' });

exports.createTour = factory.createOne(Tour);

exports.updateTour = factory.updateOne(Tour);

exports.deleteTour = factory.deleteOne(Tour); // factory.deleteOne(Tour) will return a function which will be sitting here until it's called
// exports.deleteTour = catchAsync(async (req, res, next) => {
//   const tour = await Tour.findByIdAndDelete(req.params.id);
//   if (!tour) return next(new AppError('No tour found with that ID', 404));
//   res.status(204).json({
//     status: 'success',
//     data: null,
//   });
// });

exports.getTourStats = catchAsync(async (req, res, next) => {
  const stats = await Tour.aggregate([
    {
      $match: { ratingsAverage: { $gte: 4.5 } },
    },
    {
      $group: {
        _id: { $toUpper: '$difficulty' },
        numTours: { $sum: 1 }, //we add 1 for each document
        numRatings: { $sum: '$ratingsQuantity' },
        avgRating: { $avg: '$ratingsAverage' },
        avgPrice: { $avg: '$price' },
        minPrice: { $min: '$price' },
        maxPrice: { $max: '$price' },
      },
    },
    {
      $sort: {
        avgPrice: 1,
      },
    },
    // {
    //   $match: { _id: { $ne: 'EASY' } }, //not equal
    // },
  ]);
  res.status(200).json({
    status: 'success',
    data: {
      stats: stats,
    },
  });
});

exports.getMonthlyPlan = catchAsync(async (req, res, next) => {
  const year = +req.params.year;
  //so we have in each tour the startDates array, unwind will create one tour for each starting date
  const plan = await Tour.aggregate([
    {
      $unwind: '$startDates',
    },
    {
      $match: {
        startDates: {
          $gte: new Date(`${year}-01-01`),
          $lte: new Date(`${year}-12-31`),
        },
      },
    },
    {
      $group: {
        _id: { $month: '$startDates' },
        numToursOfMonth: { $sum: 1 },
        tours: {
          $push: '$name',
        },
      },
    },
    {
      $addFields: {
        month: '$_id',
      },
    },
    {
      $project: {
        _id: 0,
      },
    },
    {
      $sort: {
        numToursOfMonth: -1,
      },
    },
    {
      $limit: 12,
    },
  ]);
  res.status(200).json({
    status: 'success',
    data: {
      plan: plan,
    },
  });
});

//'/tours-within/:distance/center/:latlng/unit/:unit',
exports.getToursWithin = catchAsync(async (req, res, next) => {
  const { distance, latlng, unit } = req.params;
  const [lat, lng] = latlng.split(',');
  //MongoDB expects radians. The radius is the distance that we want to have as the radius, but converted to a special unit called radians. In order to get the radians, we need to divide the distance by the radius of the earth
  const radius = unit === 'mi' ? distance / 3963.2 : distance / 6378.1;
  if (!lat || !lng) {
    next(
      new AppError(
        'Please provide latitude and longitude in the format lat, lng',
        400
      )
    );
  }
  //we need to add a index to startLocation -> in tourModel.js
  const tours = await Tour.find({
    startLocation: { $geoWithin: { $centerSphere: [[lng, lat], radius] } },
  });
  res.status(200).json({
    status: 'success',
    results: tours.length,
    data: {
      data: tours,
    },
  });
});

exports.getDistances = catchAsync(async (req, res, next) => {
  const { latlng, unit } = req.params;
  const [lat, lng] = latlng.split(',');
  //MongoDB expects radians. The radius is the distance that we want to have as the radius, but converted to a special unit called radians. In order to get the radians, we need to divide the distance by the radius of the earth
  const multipler = unit === 'mi' ? 0.000621371 : 0.001;
  if (!lat || !lng) {
    next(
      new AppError(
        'Please provide latitude and longitude in the format lat, lng',
        400
      )
    );
  }
  //in order to do calculations, we always use the aggregation pipeline. And remember, that's called on the model itself
  const distances = await Tour.aggregate([
    {
      //this is the only geo stage pipeline, this always needs to be the first stage in the pipeline
      //this also requires the geospatial index but since we already did the index for startLocation, and now we will calulate with startLocation, we already did it.
      $geoNear: {
        near: {
          type: 'Point',
          coordinates: [+lng, +lat],
        }, //point from which to calculate the distances
        distanceField: 'distance', //name of the field that will be created and where all the distances will be stored
        distanceMultiplier: multipler, //same as meters / 1000 to get KM
      },
    },
    {
      $project: {
        //fields to keep- get rid
        distance: 1,
        name: 1,
      },
    },
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      data: distances,
    },
  });
});
